/**
 * server/scripts/build-degree-graphs.mjs
 *
 * Offline build script: scrapes TAMU catalog degree pages and generates
 * server/data/generated-degree-graphs.json which is loaded at runtime as
 * a pre-built fallback in degreeGraphBuilder.js.
 *
 * Usage:
 *   node server/scripts/build-degree-graphs.mjs                           # Engineering only
 *   node server/scripts/build-degree-graphs.mjs --all                     # all programs
 *   node server/scripts/build-degree-graphs.mjs --college engineering     # specific college
 *   node server/scripts/build-degree-graphs.mjs --program catalog-major:... # single program
 *
 * Output: server/data/generated-degree-graphs.json
 *   { [programId]: GraphObject, ... }
 *
 * Runtime: ~2–5 min for all Engineering programs (network I/O bound).
 * The output file is checked into the repo and loaded statically at runtime.
 * Re-run whenever catalog data changes.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data');
const OUTPUT_PATH = join(DATA_DIR, 'generated-degree-graphs.json');
const PROGRAMS_PATH = join(DATA_DIR, 'academic-programs.json');

const CATALOG_BASE = 'https://catalog.tamu.edu';
const FETCH_TIMEOUT_MS = 25000;
const FETCH_RETRIES = 3;
const RETRY_DELAY_MS = 800;
const REQUEST_DELAY_MS = 300; // polite delay between requests

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flagAll = args.includes('--all');
const flagCollege = (args[args.indexOf('--college') + 1] ?? '').toLowerCase();
const flagProgram = args[args.indexOf('--program') + 1] ?? '';

// ── helpers ──────────────────────────────────────────────────────────────────

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stripTags(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(Number(c)))
    .replace(/\s+/g, ' ').trim();
}

function extractCourseCodes(text) {
  const seen = new Set();
  const results = [];
  const upper = String(text ?? '').toUpperCase();
  const re = /\b([A-Z]{3,5})\s*(\d{3}[A-Z]?)\b/gu;
  let m;
  while ((m = re.exec(upper)) !== null) {
    const code = `${m[1]} ${m[2]}`;
    if (!seen.has(code)) { seen.add(code); results.push(code); }
  }
  return results;
}

function parseCreditHours(text) {
  const ms = [...String(text ?? '').matchAll(/\d+(?:\.\d+)?/g)].map((m) => parseFloat(m[0]));
  if (!ms.length) return 0;
  return Math.max(...ms);
}

async function fetchHtml(url) {
  let lastErr;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(String(url), {
        headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'zlp-build/1.0' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return await res.text();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < FETCH_RETRIES) {
        console.warn(`    Retry ${attempt + 1}/${FETCH_RETRIES}: ${err.message}`);
        await wait(RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }
  throw lastErr;
}

// ── Plan grid parser ──────────────────────────────────────────────────────────

function parsePlanTableFromHtml(html) {
  const graphNodes = [];
  const requirementGroups = [];
  const colSeqMap = new Map();
  let currentYear = 'Year I';
  let currentTerm = 'Fall';
  let nodeIdx = 0;

  function getColId() {
    const key = `${currentYear}::${currentTerm}`;
    if (!colSeqMap.has(key)) colSeqMap.set(key, colSeqMap.size);
    return `col-${colSeqMap.get(key)}`;
  }

  const tableMatches = [...html.matchAll(/<table[^>]*class="sc_plangrid"[\s\S]*?<\/table>/gi)];

  for (const [tableHtml] of tableMatches) {
    const rows = [...tableHtml.matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/gi)];
    let pendingChoice = null;

    function flushPendingChoice() {
      if (!pendingChoice) return;
      const singleCodes = pendingChoice.options.filter((o) => o.length === 1).map((o) => o[0]);
      if (singleCodes.length >= 2) {
        nodeIdx++;
        graphNodes.push({
          id: `choice-${nodeIdx}`,
          type: 'choice',
          column: pendingChoice.colId,
          code: singleCodes.join(' / '),
          title: pendingChoice.title,
          hours: pendingChoice.hours,
          matches: [...new Set(singleCodes)],
          options: [...new Set(singleCodes)],
          prereqs: [], coreqs: [], required: true,
        });
      } else {
        requirementGroups.push({ label: pendingChoice.title, hours: pendingChoice.hours });
      }
      pendingChoice = null;
    }

    for (const [, attrs, rowHtml] of rows) {
      const cls = (attrs.match(/class="([^"]+)"/) ?? [])[1] ?? '';

      if (/plangridyear/.test(cls)) {
        flushPendingChoice();
        currentYear = stripTags(rowHtml);
        continue;
      }
      if (/plangridterm/.test(cls)) {
        flushPendingChoice();
        const tc = [...rowHtml.matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)];
        if (tc[0]) currentTerm = stripTags(tc[0][1]);
        continue;
      }
      if (/plangridsum|plangridtotal|plangridsub/.test(cls)) { flushPendingChoice(); continue; }

      const cells = [...rowHtml.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi)].map(([, a, h]) => ({
        colspan: parseInt((a.match(/colspan="(\d+)"/) ?? [])[1] ?? '1', 10),
        html: h, text: stripTags(h),
      }));
      if (cells.length < 2) continue;

      const codeCell = cells[0];
      const titleCell = cells[1] ?? cells[0];
      const hoursCell = cells[cells.length - 1];
      const hours = parseCreditHours(hoursCell.text);
      const codeText = codeCell.text;
      const codeCodes = extractCourseCodes(codeCell.html);
      const colId = getColId();

      // Continuation row inside pending choice group
      if (pendingChoice && hoursCell.text.trim() === '' && codeCodes.length > 0) {
        pendingChoice.options.push(codeCodes);
        continue;
      }
      flushPendingChoice();
      nodeIdx++;

      // "Select one of the following" row
      if (/select\s+one\s+of\s+the\s+following/i.test(codeText)) {
        pendingChoice = { title: stripTags(titleCell.html) || codeText, hours, colId, options: [] };
        continue;
      }

      // Generic/comment row
      if (codeCell.colspan >= 2 || codeCodes.length === 0) {
        requirementGroups.push({ label: codeText.slice(0, 120), hours });
        continue;
      }

      // Inline choice: "STAT 211 or ECEN 303"
      if (/\bor\b/i.test(codeText) && codeCodes.length >= 2) {
        graphNodes.push({
          id: `choice-${nodeIdx}`, type: 'choice', column: colId,
          code: codeCodes.join(' / '), title: stripTags(titleCell.html), hours,
          matches: [...new Set(codeCodes)], options: [...new Set(codeCodes)],
          prereqs: [], coreqs: [], required: true,
        });
        continue;
      }

      // Cross-listed: "ENGR 216 / PHYS 216"
      if (codeCodes.length >= 2 && /\//.test(codeText)) {
        graphNodes.push({
          id: `node-${nodeIdx}`, type: 'choice', column: colId,
          code: codeCodes.join(' / '), title: stripTags(titleCell.html), hours,
          matches: [...new Set(codeCodes)], options: [...new Set(codeCodes)],
          prereqs: [], coreqs: [], required: true,
        });
        continue;
      }

      // Normal single course
      graphNodes.push({
        id: `node-${nodeIdx}`, type: 'course', column: colId,
        code: codeCodes[0], title: stripTags(titleCell.html), hours,
        matches: [...new Set(codeCodes)], prereqs: [], coreqs: [], required: true,
      });
    }
    flushPendingChoice();
  }

  const subjects = [...new Set(
    graphNodes.flatMap((n) => n.matches).map((c) => c.split(' ')[0]).filter(Boolean),
  )];

  return { graphNodes, requirementGroups, subjects };
}

// ── Course catalog parser ─────────────────────────────────────────────────────

function parseCourseCatalogPage(html) {
  const courses = {};
  const blocks = [...html.matchAll(/<div class="courseblock">/gi)];

  blocks.forEach((match, i) => {
    const start = match.index;
    const end = i + 1 < blocks.length ? blocks[i + 1].index : html.length;
    const block = html.slice(start, end);

    const titleHtml = (block.match(/<h2[^>]*class="courseblocktitle"[^>]*>([\s\S]*?)<\/h2>/i) ?? [])[1] ?? '';
    const titleText = stripTags(titleHtml);
    const codeMatch = titleText.match(/\b([A-Z]{3,5})\s+(\d{3}[A-Z]?)\b/);
    if (!codeMatch) return;

    const code = `${codeMatch[1]} ${codeMatch[2]}`;
    const title = titleText
      .slice(titleText.indexOf(codeMatch[0]) + codeMatch[0].length)
      .replace(/^[\s.]+/, '').replace(/\s*\d+\s*Credits?\s*$/i, '').trim();

    const creditsMatch = stripTags(block).match(/\bCredits?\s+(\d+(?:\.\d+)?)\b/i);
    const hours = creditsMatch ? parseFloat(creditsMatch[1]) : 0;

    const descHtml = block.replace(/<h2[^>]*>[\s\S]*?<\/h2>/i, '');
    const prereqHtml = (descHtml.match(/<strong>Prerequisites?[^<]*<\/strong>([\s\S]*?)(?=<strong>|<\/p>|<p\s|$)/i) ?? [])[1] ?? '';
    const coreqHtml  = (descHtml.match(/<strong>Corequisites?[^<]*<\/strong>([\s\S]*?)(?=<strong>|<\/p>|<p\s|$)/i) ?? [])[1] ?? '';

    const prereqs = extractCourseCodes(prereqHtml).filter((c) => c !== code);
    const coreqs  = extractCourseCodes(coreqHtml).filter((c) => c !== code);

    if (/concurrent enrollment/i.test(prereqHtml)) {
      for (const c of prereqs) { if (!coreqs.includes(c)) coreqs.push(c); }
    }

    courses[code] = { code, title, hours, prereqs, coreqs: [...new Set(coreqs)] };
  });

  return courses;
}

// ── Node enrichment ───────────────────────────────────────────────────────────

async function enrichNodes(graphNodes, subjects, requestDelay = REQUEST_DELAY_MS) {
  const courseCatalog = {};

  for (const subject of subjects) {
    const url = `${CATALOG_BASE}/undergraduate/course-descriptions/${subject.toLowerCase()}/`;
    try {
      await wait(requestDelay);
      const html = await fetchHtml(url);
      Object.assign(courseCatalog, parseCourseCatalogPage(html));
      console.log(`    + catalog page fetched: ${subject} (${Object.keys(courseCatalog).length} total courses)`);
    } catch (err) {
      console.warn(`    ! Could not fetch catalog for ${subject}: ${err.message}`);
    }
  }

  const enrichedNodes = graphNodes.map((n) => {
    const info = courseCatalog[n.code] ?? n.matches?.map((m) => courseCatalog[m]).find(Boolean);
    return {
      ...n,
      title:   info?.title ?? n.title,
      hours:   (n.hours > 0 ? n.hours : null) ?? (info?.hours > 0 ? info.hours : null) ?? 0,
      prereqs: info?.prereqs ?? n.prereqs ?? [],
      coreqs:  info?.coreqs  ?? n.coreqs  ?? [],
    };
  });

  return { enrichedNodes, courseCatalog };
}

// ── Edge builder ──────────────────────────────────────────────────────────────

function buildEdgesFromNodes(nodes) {
  const knownCodes = new Set(nodes.flatMap((n) => [n.code, ...(n.matches ?? [])]));
  const edges = [];
  const seen = new Set();
  const warnings = [];

  for (const n of nodes) {
    for (const prereq of n.prereqs ?? []) {
      const key = `${prereq}->pre->${n.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!knownCodes.has(prereq)) {
        warnings.push(`Prereq ${prereq} of ${n.code} is outside degree node set.`);
      }
      edges.push({ from: prereq, to: n.code, type: 'prerequisite', rawText: '' });
    }
    for (const coreq of n.coreqs ?? []) {
      const key = `${coreq}->co->${n.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: coreq, to: n.code, type: 'corequisite', rawText: '' });
    }
  }

  return { edges, warnings };
}

// ── Single program builder ────────────────────────────────────────────────────

async function buildGraphForProgram(prog) {
  const programId = prog.id;
  // Use the catalogUrl stored in academic-programs.json (already resolved for archived years)
  const url = prog.catalogUrl ?? null;

  if (!url) {
    return {
      programId, catalog: null, title: prog.title ?? programId, sourceUrl: null,
      nodes: [], edges: [], flexibleRequirements: [],
      warnings: ['No catalog URL for this program.'], source: 'scraped',
    };
  }

  console.log(`  Fetching: ${url}`);
  let html;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
    return {
      programId, catalog: null, title: prog.title ?? programId, sourceUrl: url,
      nodes: [], edges: [], flexibleRequirements: [],
      warnings: [`Could not fetch catalog page: ${err.message}`], source: 'scraped',
    };
  }

  const h1Match = html.match(/<h1[^>]*class="[^"]*page-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)
    ?? html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h1Text = h1Match ? stripTags(h1Match[1]) : '';
  const title = (h1Text && !/texas a&m university catalogs?/i.test(h1Text) && h1Text.length < 120)
    ? h1Text
    : (prog.title ?? programId);

  const { graphNodes, requirementGroups, subjects } = parsePlanTableFromHtml(html);
  console.log(`  → ${graphNodes.length} nodes, ${subjects.length} subjects: [${subjects.join(', ')}]`);

  const { enrichedNodes, courseCatalog } = await enrichNodes(graphNodes, subjects);
  const { edges, warnings } = buildEdgesFromNodes(enrichedNodes);
  console.log(`  → ${edges.length} edges built, ${warnings.length} warnings`);

  // Convert to canonical schema shape
  const nodes = enrichedNodes.map((n) => ({
    id:               n.id,
    code:             n.code,
    subject:          n.code.split(' ')[0] ?? null,
    number:           n.code.split(' ')[1] ?? null,
    title:            n.title ?? '',
    creditHours:      n.hours ?? null,
    requirementType:  n.type === 'choice' ? 'choice' : 'required',
    semesterColumn:   n.column ?? null,
    rawRequirementText: '',
    matches:          n.matches ?? [],
    prereqs:          n.prereqs ?? [],
    coreqs:           n.coreqs ?? [],
  }));

  return {
    programId,
    catalog: '2025-2026',
    title,
    sourceUrl: url,
    nodes,
    edges,
    flexibleRequirements: requirementGroups,
    warnings,
    source: 'scraped',
    generatedAt: new Date().toISOString(),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Load academic-programs.json
  if (!existsSync(PROGRAMS_PATH)) {
    console.error('server/data/academic-programs.json not found. Run build-academic-programs.mjs first.');
    process.exit(1);
  }
  const programs = JSON.parse(readFileSync(PROGRAMS_PATH, 'utf8'));

  // Filter programs to build
  let targets = programs.filter((p) => p.type === 'major' && p.id?.startsWith('catalog-major:'));

  if (flagProgram) {
    targets = programs.filter((p) => p.id === flagProgram);
    if (targets.length === 0) {
      console.error(`Program not found: ${flagProgram}`);
      process.exit(1);
    }
  } else if (flagCollege) {
    targets = targets.filter((p) => (p.college ?? '').toLowerCase().includes(flagCollege));
  } else if (!flagAll) {
    // Default: Engineering only
    targets = targets.filter((p) => p.college === 'Engineering');
  }

  // Skip programs that already have static degree-plans data (they don't need scraping)
  targets = targets.filter((p) => !p.hasDetailedPlan);

  console.log(`\nBuilding degree graphs for ${targets.length} program(s)...`);
  if (targets.length === 0) {
    console.log('Nothing to build (all selected programs have static plan data).');
    process.exit(0);
  }

  // Load existing output if any (so we can merge and not lose prior builds)
  let existing = {};
  if (existsSync(OUTPUT_PATH)) {
    try { existing = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8')); } catch {}
  }

  const results = { succeeded: 0, failed: 0, skipped: 0 };

  for (let i = 0; i < targets.length; i++) {
    const prog = targets[i];
    console.log(`\n[${i + 1}/${targets.length}] ${prog.id}`);
    console.log(`  ${prog.title ?? '(no title)'} — ${prog.college ?? ''}`);

    try {
      const graph = await buildGraphForProgram(prog);
      existing[prog.id] = graph;
      if (graph.nodes.length > 0) {
        results.succeeded++;
      } else {
        results.skipped++;
        console.log('  → Skipped (no nodes generated)');
      }
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      results.failed++;
    }

    // Small delay between programs to be polite to catalog server
    if (i < targets.length - 1) await wait(500);
  }

  // Write output
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(existing, null, 2), 'utf8');

  console.log('\n─────────────────────────────────────────────');
  console.log(`Done. ${results.succeeded} succeeded, ${results.skipped} empty, ${results.failed} failed.`);
  console.log(`Output: ${OUTPUT_PATH}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
