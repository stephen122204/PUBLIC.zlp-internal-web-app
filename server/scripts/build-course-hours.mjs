/**
 * server/scripts/build-course-hours.mjs
 *
 * Builds server/data/course-hours.json — a compact map of
 *   { "SUBJ NUM": creditHours }
 * for every college-station course that has appeared in the last N terms.
 *
 * Strategy:
 *   1. Load catalog-index.json, find the most recent termCodes for
 *      college-station (up to MAX_TERMS_TO_FETCH distinct terms).
 *   2. Fetch ALL sections for each of those terms from Howdy in one POST each.
 *   3. From the section rows extract SWV_CLASS_SEARCH_HOURS_LOW.
 *   4. For each subject+courseNumber keep the most recent non-null hoursLow.
 *   5. Write server/data/course-hours.json.
 *
 * Run manually:
 *   node server/scripts/build-course-hours.mjs
 *
 * Do NOT run on every server start. Commit the output file.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip, createBrotliDecompress, createInflate } from 'node:zlib';
import { request as httpsRequest } from 'node:https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = join(__dirname, '../data');
const INDEX_PATH = join(DATA_DIR, 'catalog-index.json');
const OUT_PATH   = join(DATA_DIR, 'course-hours.json');

const HOWDY_BASE_URL   = process.env.HOWDY_BASE_URL ?? 'https://howdy.tamu.edu';
const MAX_TERMS        = 3;   // fetch the N most recent college-station terms
const REQUEST_TIMEOUT  = 60_000;
const MAX_RETRIES      = 2;
const RETRY_DELAY      = 500;

// ---------------------------------------------------------------------------
// Howdy HTTP helper (mirrors courseSections.js — no shared dep in scripts)
// ---------------------------------------------------------------------------

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function decompressBuffer(buffer, encoding) {
  const enc = String(encoding ?? '').toLowerCase().trim();
  return new Promise((resolve, reject) => {
    if (!enc || enc === 'identity') { resolve(buffer); return; }
    const stream =
      enc === 'gzip' || enc === 'x-gzip' ? createGunzip() :
      enc === 'br'                        ? createBrotliDecompress() :
                                            createInflate();
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    stream.end(buffer);
  });
}

async function fetchHowdySections(termCode) {
  const payload = JSON.stringify({ startRow: 0, endRow: 0, termCode, publicSearch: 'Y' });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await wait(RETRY_DELAY * attempt);
    const rows = await new Promise((resolve, reject) => {
      const url = new URL('/api/course-sections', HOWDY_BASE_URL);
      const req = httpsRequest(
        {
          hostname: url.hostname,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept-Encoding': 'br, gzip, deflate, identity',
            'User-Agent': 'Mozilla/5.0 (compatible; ZLP-hours-builder/1.0)',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: REQUEST_TIMEOUT,
        },
        async (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', async () => {
            try {
              const raw = await decompressBuffer(Buffer.concat(chunks), res.headers['content-encoding']);
              const json = JSON.parse(raw.toString('utf8'));
              const data = Array.isArray(json) ? json : (json?.data ?? json?.rows ?? []);
              resolve(data);
            } catch (e) { reject(e); }
          });
        }
      );
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
    if (rows.length > 0) return rows;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('Loading catalog index…');
const catalog = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
const entries = Array.isArray(catalog?.entries) ? catalog.entries : [];

// Find the most recent N distinct termCodes for college-station campus
const csTerms = [...new Set(
  entries
    .filter((e) => e.campus === 'college-station')
    .map((e) => String(e.termCode))
)]
  .sort((a, b) => Number(b) - Number(a))
  .slice(0, MAX_TERMS);

console.log(`Will fetch ${csTerms.length} terms: ${csTerms.join(', ')}`);

// { "SUBJ NUM" -> { hours, termCode } }
const hoursMap = new Map();

for (const termCode of csTerms) {
  console.log(`  Fetching term ${termCode} from Howdy…`);
  let rows;
  try {
    rows = await fetchHowdySections(termCode);
  } catch (err) {
    console.warn(`  ⚠ Failed to fetch ${termCode}: ${err.message}`);
    continue;
  }
  console.log(`  → ${rows.length} section rows`);

  for (const row of rows) {
    const subj = String(row.SWV_CLASS_SEARCH_SUBJECT ?? '').trim().toUpperCase();
    const num  = String(row.SWV_CLASS_SEARCH_COURSE  ?? '').trim();
    if (!subj || !num) continue;

    const hours = row.SWV_CLASS_SEARCH_HOURS_LOW != null ? Number(row.SWV_CLASS_SEARCH_HOURS_LOW) : null;
    if (hours == null || !Number.isFinite(hours)) continue;

    const code = `${subj} ${num}`;
    const existing = hoursMap.get(code);
    // Prefer non-zero over zero: a 0-credit section row (e.g. a lab attachment) should
    // not overwrite a previously recorded real credit-hour value for the same course.
    // Only update if: newer term AND (new value > 0, OR we have no non-zero value yet).
    const isNewer = !existing || Number(termCode) > Number(existing.termCode);
    const promotesZero = existing && existing.hours > 0 && hours === 0;
    if (isNewer && !promotesZero) {
      hoursMap.set(code, { hours: Math.round(hours), termCode });
    }
  }
}

// Flatten to a plain object for fast O(1) lookup
const out = {};
for (const [code, { hours }] of hoursMap) {
  out[code] = hours;
}

const outJson = JSON.stringify({ generatedAt: new Date().toISOString(), courseCount: Object.keys(out).length, hours: out }, null, 0);
writeFileSync(OUT_PATH, outJson, 'utf8');

console.log(`\n✓ Wrote ${OUT_PATH}`);
console.log(`  ${Object.keys(out).length} courses with credit-hour data.`);
