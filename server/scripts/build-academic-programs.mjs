/**
 * server/scripts/build-academic-programs.mjs
 *
 * Fetches the TAMU undergraduate catalog index and builds:
 *   server/data/academic-programs.json  (bachelor programs/majors)
 *   server/data/academic-minors.json    (minors, if catalog page available)
 *
 * Run manually:
 *   node server/scripts/build-academic-programs.mjs              # current year only
 *   node server/scripts/build-academic-programs.mjs --all        # last 5 years
 *   node server/scripts/build-academic-programs.mjs --year 2023-2024  # specific year
 *
 * Do NOT run on every server request. Output files are committed and loaded
 * statically by server/src/lib/academicPrograms.js.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data');

const CATALOG_BASE = 'https://catalog.tamu.edu';
const CURRENT_CATALOG = '2025-2026';
const FETCH_TIMEOUT_MS = 25000;
const FETCH_RETRIES = 3;
const RETRY_DELAY_MS = 600;

// ── helpers ──────────────────────────────────────────────────────────────────

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeWS(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(Number(c)))
    .replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#8203;/g, '');
}

function stripTags(html) {
  return normalizeWS(decodeHtml(String(html ?? '').replace(/<[^>]+>/g, ' ')));
}

async function fetchHtml(url) {
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': 'zlp-app-build-script/1.0', accept: 'text/html' },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.text();
    } catch (err) {
      clearTimeout(timer);
      if (attempt >= FETCH_RETRIES) throw err;
      console.warn(`  Retry ${attempt + 1}/${FETCH_RETRIES} for ${url}: ${err.message}`);
      await wait(RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

// ── program / minor detection ─────────────────────────────────────────────────

const BACHELOR_RE = /\b(BA|BS|BBA|BFA|BLA|BM|BSN|BGS|BED|B\.S\.|B\.A\.)\b/i;
const EXCLUDE_RE = /3\+\d|combined degree|certificate$/i;
const MINOR_RE = /\bminor\b/i;

function isBachelorTitle(t) {
  return BACHELOR_RE.test(t) && !EXCLUDE_RE.test(t);
}

function isMinorTitle(t) {
  return MINOR_RE.test(t) && !BACHELOR_RE.test(t);
}

// Infer college from catalog path
function inferCollege(path) {
  const colleges = {
    'agriculture': 'Agriculture and Life Sciences',
    'architecture': 'Architecture',
    'arts-sciences': 'Arts and Sciences',
    'liberal-arts': 'Liberal Arts',
    'bush': 'Bush School of Government',
    'business': 'Mays Business School',
    'education': 'Education and Human Development',
    'engineering': 'Engineering',
    'geosciences': 'Geosciences',
    'law': 'School of Law',
    'medicine': 'Medicine',
    'nursing': 'Nursing',
    'performance': 'Performance, Visualization & Fine Arts',
    'veterinary': 'Veterinary Medicine and Biomedical Sciences',
    'visualization': 'Performance, Visualization & Fine Arts',
  };
  for (const [key, name] of Object.entries(colleges)) {
    if (path.includes(key)) return name;
  }
  return null;
}

// The bs-cs-2025 plan has detailed data in degree-plans.json
const DETAILED_PLAN_IDS = new Set(['bs-cs-2025']);

// ── extract links from HTML ──────────────────────────────────────────────────

/**
 * Extract undergraduate program links.
 * For current catalog: href="/undergraduate/..."
 * For archives:        href="/archives/YYYY-YYYY/undergraduate/..."
 */
function extractLinks(html, catalogYear) {
  const isArchive = catalogYear !== CURRENT_CATALOG;
  // Match either current or archive path patterns
  const re = isArchive
    ? new RegExp(`<a\\s+href="(\\/archives\\/${catalogYear}\\/undergraduate\\/[^"#?]+)"[^>]*>([\\s\\S]*?)<\\/a>`, 'gi')
    : /<a\s+href="(\/undergraduate\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  return [...html.matchAll(re)]
    .map(([, href, labelHtml]) => ({
      href: decodeHtml(href).replace(/\/+$/, '/'),
      title: normalizeWS(stripTags(labelHtml).replace(/\u200b/g, '')),
    }))
    .filter(({ title }) => title && title.length >= 4);
}

// ── fetch one catalog year ────────────────────────────────────────────────────

async function buildYear(catalogYear) {
  const isArchive = catalogYear !== CURRENT_CATALOG;
  const ugIndexUrl = isArchive
    ? `${CATALOG_BASE}/archives/${catalogYear}/undergraduate/`
    : `${CATALOG_BASE}/undergraduate/`;

  console.log(`\n── Fetching ${catalogYear} from ${ugIndexUrl}`);
  let mainHtml;
  try {
    mainHtml = await fetchHtml(ugIndexUrl);
  } catch (err) {
    console.error(`Failed to fetch ${catalogYear} catalog index: ${err.message}`);
    return { programs: [], minors: [] };
  }

  const mainLinks = extractLinks(mainHtml, catalogYear);
  console.log(`  Found ${mainLinks.length} undergraduate anchor links`);

  const programs = [];
  const minors = [];
  const seenPrograms = new Set();
  const seenMinors = new Set();

  // Normalize href: strip archive prefix to get the "slug" for IDs
  function getSlug(href) {
    return href
      .replace(`/archives/${catalogYear}/undergraduate/`, '')
      .replace(/^\/undergraduate\//, '')
      .replace(/\/$/, '');
  }

  function processLink(href, title) {
    const slug = getSlug(href);
    const college = inferCollege(href) ?? null;
    const catalogUrl = `${CATALOG_BASE}${href}`;
    const hasDetailedPlan = href.includes('/engineering/computer-science/bs');

    // Skip Qatar-campus programs (same degree, same college label as College Station)
    // and the cross-listed Computer Engineering entry under /computer-science/
    // to prevent duplicate entries in the program picker.
    if (slug.startsWith('qatar/')) return;
    if (slug.startsWith('engineering/computer-science/computer-engineering')) return;

    if (isBachelorTitle(title)) {
      const id = `catalog-major:${slug}:${catalogYear}`;
      if (seenPrograms.has(id)) return;
      seenPrograms.add(id);
      programs.push({
        id,
        type: 'major',
        level: 'undergraduate',
        title,
        college,
        department: null,
        catalog: catalogYear,
        catalogUrl,
        hasDetailedPlan,
        degreePlanId: hasDetailedPlan ? 'bs-cs-2025' : null,
      });
    } else if (isMinorTitle(title)) {
      const id = `catalog-minor:${slug}:${catalogYear}`;
      if (seenMinors.has(id)) return;
      seenMinors.add(id);
      minors.push({
        id,
        type: 'minor',
        title,
        college,
        department: null,
        catalog: catalogYear,
        catalogUrl,
        hasDetailedPlan: false,
        degreePlanId: null,
      });
    }
  }

  for (const { href, title } of mainLinks) {
    processLink(href, title);
  }

  // Crawl college subpages for minors
  const collegeSubpages = new Set();
  for (const { href } of mainLinks) {
    const slug = getSlug(href);
    const parts = slug.split('/');
    if (parts.length === 1 && parts[0]) {
      const base = isArchive
        ? `${CATALOG_BASE}/archives/${catalogYear}/undergraduate/${parts[0]}/`
        : `${CATALOG_BASE}/undergraduate/${parts[0]}/`;
      collegeSubpages.add(base);
    }
  }

  console.log(`  Crawling ${collegeSubpages.size} college subpages for minors…`);
  let crawled = 0;
  for (const url of collegeSubpages) {
    try {
      const html = await fetchHtml(url);
      const links = extractLinks(html, catalogYear);
      for (const { href, title } of links) {
        if (isMinorTitle(title)) processLink(href, title);
      }
      crawled++;
      process.stdout.write(`\r  ${crawled}/${collegeSubpages.size} crawled, ${minors.length} minors found`);
    } catch {
      // Subpage may not exist; skip silently
    }
    await wait(120);
  }
  console.log();

  return { programs, minors };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function build() {
  // Parse CLI args
  const args = process.argv.slice(2);
  let yearsToFetch = [CURRENT_CATALOG];

  if (args.includes('--all')) {
    // Last 5 catalog years (matching the dropdown range)
    const currentStartYear = parseInt(CURRENT_CATALOG.split('-')[0], 10);
    yearsToFetch = [];
    for (let y = currentStartYear - 4; y <= currentStartYear; y++) {
      yearsToFetch.push(`${y}-${y + 1}`);
    }
  } else {
    const yearFlag = args.indexOf('--year');
    if (yearFlag !== -1 && args[yearFlag + 1]) {
      yearsToFetch = [args[yearFlag + 1]];
    }
  }

  console.log(`Catalog years to fetch: ${yearsToFetch.join(', ')}`);

  // Load existing data to merge with
  let existingPrograms = [];
  let existingMinors = [];
  const programsPath = join(DATA_DIR, 'academic-programs.json');
  const minorsPath = join(DATA_DIR, 'academic-minors.json');

  if (existsSync(programsPath)) {
    try {
      const raw = JSON.parse(readFileSync(programsPath, 'utf8'));
      existingPrograms = Array.isArray(raw.programs) ? raw.programs : [];
      // Remove entries for years we're about to re-fetch
      existingPrograms = existingPrograms.filter((p) => !yearsToFetch.includes(p.catalog));
    } catch { existingPrograms = []; }
  }
  if (existsSync(minorsPath)) {
    try {
      const raw = JSON.parse(readFileSync(minorsPath, 'utf8'));
      existingMinors = Array.isArray(raw.minors) ? raw.minors : [];
      existingMinors = existingMinors.filter((m) => !yearsToFetch.includes(m.catalog));
    } catch { existingMinors = []; }
  }

  const allPrograms = [...existingPrograms];
  const allMinors = [...existingMinors];

  for (const catalogYear of yearsToFetch) {
    const { programs, minors } = await buildYear(catalogYear);

    // Ensure bs-cs entry exists for the current year
    if (catalogYear === CURRENT_CATALOG && !programs.some((p) => p.hasDetailedPlan)) {
      programs.push({
        id: 'bs-cs-2025',
        type: 'major',
        level: 'undergraduate',
        title: 'Computer Science - BS',
        college: 'Engineering',
        department: 'Computer Science and Engineering',
        catalog: catalogYear,
        catalogUrl: `${CATALOG_BASE}/undergraduate/engineering/computer-science/bs/`,
        hasDetailedPlan: true,
        degreePlanId: 'bs-cs-2025',
      });
    }

    allPrograms.push(...programs);
    allMinors.push(...minors);
    console.log(`  ${catalogYear}: ${programs.length} programs, ${minors.length} minors`);
  }

  allPrograms.sort((a, b) => a.catalog.localeCompare(b.catalog) || a.title.localeCompare(b.title));
  allMinors.sort((a, b) => a.catalog.localeCompare(b.catalog) || a.title.localeCompare(b.title));

  const now = new Date().toISOString();
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(programsPath, JSON.stringify({ generatedAt: now, programs: allPrograms }, null, 2));
  writeFileSync(minorsPath, JSON.stringify({ generatedAt: now, minors: allMinors }, null, 2));

  console.log(`\nWrote academic-programs.json: ${allPrograms.length} total programs`);
  console.log(`Wrote academic-minors.json:   ${allMinors.length} total minors`);
  if (allPrograms.filter(p => p.catalog === CURRENT_CATALOG).length === 0) {
    console.warn('WARNING: No programs found for current year. Catalog structure may have changed.');
  }
}

build().catch((err) => { console.error(err); process.exit(1); });
