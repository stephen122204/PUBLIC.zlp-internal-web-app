/**
 * build-cross-listings.mjs
 *
 * Builds the full set of cross-listed / equivalent course groups — the SAME
 * course offered under multiple department codes — from the TAMU course-
 * description catalog. Two signals are captured:
 *
 *   1. Formal "Cross Listing:" lines           e.g. CYBR 201 / CSCE 201
 *   2. Same course NUMBER + identical title    e.g. CSCE 421 / STAT 421
 *      + identical description prose                (both "Machine Learning",
 *                                                    identical text, no XL tag)
 *
 * (2) is essential: many equivalents like CSCE 421 / STAT 421 carry NO "Cross
 * Listing:" tag yet are the same course. Generic courses (research, seminar,
 * special topics, …) are excluded so their boilerplate descriptions don't group.
 *
 * Groups that share a code are unioned (handles 3-way equivalences).
 *
 * Output (same data, two consumers):
 *   server/data/cross-listings.json    — classifier (courseClassifier)
 *   client/src/data/crossListings.json — flowchart (degreePlanEvaluation)
 *
 * Usage:  node scripts/build-cross-listings.mjs
 *         node scripts/build-cross-listings.mjs --subjects=CSCE,STAT,MATH
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpsRequest } from 'node:https';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_OUT = path.join(__dirname, '..', 'data', 'cross-listings.json');
const CLIENT_OUT = path.join(__dirname, '..', '..', 'client', 'src', 'data', 'crossListings.json');
const CATALOG_INDEX = path.join(__dirname, '..', 'data', 'catalog-index.json');
const HOST = 'catalog.tamu.edu';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v];
}));

// Generic / variable-content course titles whose boilerplate descriptions repeat
// across subjects — never treat these as cross-listed by content.
const GENERIC_TITLE_RE = /directed studies|special topics|research|internship|independent study|seminar|problems|thesis|dissertation|practicum|field (experience|practicum)|study abroad|honors|cooperative education|professional internship|teaching|readings|conference|topics in|workshop/i;

function allSubjects() {
  if (args.subjects) return args.subjects.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const idx = JSON.parse(fs.readFileSync(CATALOG_INDEX, 'utf8'));
  const arr = Array.isArray(idx) ? idx : (idx.entries || idx.courses || []);
  return [...new Set(arr.map((e) => String(e.subject || '').toUpperCase()).filter(Boolean))].sort();
}

// ---- http (with retry + redirect follow) ----------------------------------
function get(reqPath) {
  return new Promise((resolve) => {
    const req = httpsRequest({ host: HOST, path: reqPath, method: 'GET', headers: { 'User-Agent': 'zlp-scheduler/1.0' } }, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location) { res.resume(); return resolve({ redirect: res.headers.location }); }
      if (code !== 200) { res.resume(); return resolve({ html: null }); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => resolve({ html: null }));
    });
    req.setTimeout(30000, () => { req.destroy(); resolve({ html: null }); });
    req.on('error', () => resolve({ html: null }));
    req.end();
  });
}
async function fetchSubject(subject) {
  let reqPath = `/undergraduate/course-descriptions/${subject.toLowerCase()}/`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await get(reqPath);
    if (res.redirect) { reqPath = res.redirect; continue; }
    if (res.html) return res.html;
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); // transient — retry
  }
  return null;
}

// ---- parse ----------------------------------------------------------------
const stripTags = (s) => String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const normCode = (s) => {
  const m = String(s).toUpperCase().match(/([A-Z]{3,5})\s*(\d{3}[A-Z]?)/);
  return m ? `${m[1]} ${m[2]}` : null;
};

/** Parse one subject page into { courses:[{code,number,title,prose}], xlGroups:[[...]] } */
function parsePage(html) {
  const courses = [];
  const xlGroups = [];
  const blocks = html.split('<div class="courseblock">').slice(1);
  for (const block of blocks) {
    const titleM = block.match(/<h2 class="courseblocktitle">([\s\S]*?)<\/h2>/);
    if (!titleM) continue;
    const titleText = stripTags(titleM[1]); // "CSCE 421 Machine Learning" or "CSCE 201/CYBR 201 Fundamentals…"

    // The title itself encodes formal cross-listings as a slash-joined code group
    // BEFORE the course name, e.g. "CSCE 201/CYBR 201 Fundamentals of Cybersecurity"
    // (codes may even differ in number, e.g. "CSCE 320/STAT 335"). Pull all leading codes.
    const titleCodes = [];
    let rest = titleText;
    for (;;) {
      const m = rest.match(/^([A-Z]{3,5})\s*(\d{3}[A-Z]?)\s*/);
      if (!m) break;
      titleCodes.push(`${m[1]} ${m[2]}`);
      rest = rest.slice(m[0].length);
      if (rest.startsWith('/')) { rest = rest.slice(1).replace(/^\s+/, ''); continue; }
      break;
    }
    if (titleCodes.length === 0) continue;
    if (titleCodes.length >= 2) xlGroups.push([...new Set(titleCodes)]); // formal cross-listing

    const code = titleCodes[0];
    const number = code.split(' ')[1];
    const title = rest.trim();

    const descM = block.match(/<p class="courseblockdesc">([\s\S]*?)<\/p>/);
    const descHtml = descM ? descM[1] : '';

    // Also capture any explicit "Cross Listing:" line (belt-and-suspenders).
    let xlM;
    const xlRe = /Cross[\s-]*Listing:?\s*<\/strong>\s*<a[^>]*>([^<]+)<\/a>/gi;
    while ((xlM = xlRe.exec(descHtml)) !== null) {
      const codes = xlM[1].split('/').map(normCode).filter(Boolean);
      if (codes.length >= 2) xlGroups.push([...new Set(codes)]);
    }

    // Description PROSE: text after the hours span, up to the first
    // Prerequisite/Corequisite/Cross Listing/Recommended marker.
    let prose = stripTags(descHtml.replace(/<span class="hours">[\s\S]*?<\/span>/i, ''));
    prose = prose.split(/Prerequisite|Corequisite|Cross[\s-]*Listing|Recommended|Restricted/i)[0]
      .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

    courses.push({ code, number, title: title.toLowerCase(), prose });
  }
  return { courses, xlGroups };
}

// ---- union-find -----------------------------------------------------------
function mergeGroups(groups) {
  const parent = new Map();
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r); while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; } return r; };
  const union = (a, b) => { add(a); add(b); parent.set(find(a), find(b)); };
  for (const g of groups) for (let i = 1; i < g.length; i += 1) union(g[0], g[i]);
  const classes = new Map();
  for (const code of parent.keys()) {
    const r = find(code);
    if (!classes.has(r)) classes.set(r, new Set());
    classes.get(r).add(code);
  }
  return [...classes.values()].map((s) => [...s].sort()).filter((g) => g.length >= 2)
    .sort((a, b) => a[0].localeCompare(b[0]));
}

// ---- main -----------------------------------------------------------------
async function main() {
  const subjects = allSubjects();
  console.log(`Scraping cross-listings + equivalents from ${subjects.length} subject page(s)…`);
  const rawGroups = [];
  const byContent = new Map(); // "number|title|prose" -> Set<code>
  let fetched = 0, failed = 0;

  for (const subject of subjects) {
    const html = await fetchSubject(subject);
    if (!html) { failed += 1; process.stdout.write('x'); continue; }
    fetched += 1;
    const { courses, xlGroups } = parsePage(html);
    rawGroups.push(...xlGroups);
    for (const c of courses) {
      if (!c.prose || c.prose.length < 60) continue;       // need a substantive description
      if (GENERIC_TITLE_RE.test(c.title)) continue;        // skip research/seminar/etc.
      const key = `${c.number}|${c.title}|${c.prose}`;
      if (!byContent.has(key)) byContent.set(key, new Set());
      byContent.get(key).add(c.code);
    }
    process.stdout.write(xlGroups.length ? '+' : '.');
  }
  process.stdout.write('\n');

  // Same number + identical title + identical prose, across ≥2 subjects → equivalent.
  let contentGroups = 0;
  for (const codes of byContent.values()) {
    if (codes.size >= 2) { rawGroups.push([...codes]); contentGroups += 1; }
  }

  const groups = mergeGroups(rawGroups);
  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'catalog.tamu.edu course descriptions (formal cross-listings + identical-content equivalents)',
    groupCount: groups.length,
    groups,
  };
  fs.writeFileSync(SERVER_OUT, JSON.stringify(payload));
  fs.mkdirSync(path.dirname(CLIENT_OUT), { recursive: true });
  fs.writeFileSync(CLIENT_OUT, JSON.stringify(payload));

  console.log(`\nDone. ${fetched} pages fetched, ${failed} failed. ${contentGroups} content-equivalent groups found.`);
  console.log(`Total equivalence groups: ${groups.length}. Written to:\n  ${SERVER_OUT}\n  ${CLIENT_OUT}`);
  const csce = groups.find((g) => g.includes('CSCE 421'));
  console.log('CSCE 421 group:', csce ? csce.join(' / ') : '(not found)');
}

main().catch((e) => { console.error(e); process.exit(1); });
