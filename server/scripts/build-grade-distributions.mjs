/**
 * build-grade-distributions.mjs
 *
 * Offline scraper for TAMU grade-distribution reports. Fetches one PDF per
 * college × semester from web-as.tamu.edu, parses each section's GPA + instructor,
 * and aggregates per (course, instructor) into:
 *   - overall GPA (enrollment-weighted across all scraped terms)
 *   - per-term GPA history (most-recent first) so the UI can show "last taught"
 *     and "prior semester".
 *
 * Output: server/data/grade-distributions.json
 *
 * Usage:
 *   node scripts/build-grade-distributions.mjs                 # full rebuild, defaults below
 *   node scripts/build-grade-distributions.mjs --colleges=EN,AT --years=2023,2024,2025
 *   node scripts/build-grade-distributions.mjs --semesters=SPRING,FALL
 *
 *   # Incremental: keep everything already in the file, fetch ONLY terms not yet
 *   # captured. Completed semesters never change, so ongoing maintenance is just:
 *   node scripts/build-grade-distributions.mjs --incremental --years=2026
 *
 * This is intentionally a periodic/offline job (PDFs are large), NOT a per-request
 * fetch — same pattern as build-degree-graphs / build-course-hours.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpsRequest } from 'node:https';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseGradeReportPdf } = require('../src/lib/gradeReportParser.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, '..', 'data', 'grade-distributions.json');
const HOST = 'web-as.tamu.edu';
// ShowReportPage POSTs then 302-redirects to this GET, which serves the PDF directly.
const REPORT_PATH = '/gradereports/Report';

// ---- CLI args -------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const DEFAULT_COLLEGES = ['EN', 'AT', 'SC']; // Engineering, Arts & Sciences (post-2022), Science (pre-2022)
const COLLEGES  = (args.colleges  ?? DEFAULT_COLLEGES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const YEARS     = (args.years     ?? '2023,2024,2025').split(',').map((s) => s.trim()).filter(Boolean);
const SEMESTERS = (args.semesters ?? 'SPRING,SUMMER,FALL').split(',').map((s) => s.trim()).filter(Boolean);

const SEM_ORDER = { SPRING: 1, SUMMER: 2, FALL: 3 };
const termSortKey = (year, sem) => Number(year) * 10 + (SEM_ORDER[sem] ?? 0);

// ---- HTTP -----------------------------------------------------------------
function fetchReport(year, semester, college) {
  const path = `${REPORT_PATH}?year=${year}&term=${semester}&college=${college}`;
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: HOST, path, method: 'GET', headers: { 'User-Agent': 'zlp-scheduler/1.0' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, buffer: Buffer.concat(chunks) }));
        res.on('error', reject);
      }
    );
    req.setTimeout(60000, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

const isPdf = (buf) => buf && buf.length > 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
const round3 = (x) => Math.round(x * 1000) / 1000;
const INCREMENTAL = 'incremental' in args;
const parseTermLabel = (label) => { const [sem, year] = String(label).split(' '); return termSortKey(year, sem); };

// ---- Aggregation ----------------------------------------------------------
// courseKey "CSCE 221" -> instructorKey "LEYK T" -> Map<termKey, {termKey, termLabel, sum, n, sections}>
// Overall GPA is derived from the per-term entries at finalize time, which lets
// us re-seed the aggregation from a previously written file (incremental mode):
// completed terms never change, so we only fetch + merge terms not yet captured.
const courses = new Map();

function addTerm(courseKey, instrKey, termKey, termLabel, gpaSum, n, sectionInc) {
  if (!courses.has(courseKey)) courses.set(courseKey, new Map());
  const instrs = courses.get(courseKey);
  if (!instrs.has(instrKey)) instrs.set(instrKey, new Map());
  const terms = instrs.get(instrKey);
  if (!terms.has(termKey)) terms.set(termKey, { termKey, termLabel, sum: 0, n: 0, sections: 0 });
  const t = terms.get(termKey);
  t.sum += gpaSum; t.n += n; t.sections += sectionInc;
}

function addRecord(rec, year, semester) {
  if (!rec.instructor || !Number.isFinite(rec.gpa)) return;
  const n = Number.isFinite(rec.afTotal) && rec.afTotal > 0 ? rec.afTotal : 0;
  if (n === 0) return; // no graded students → no GPA signal
  addTerm(`${rec.subject} ${rec.course}`, rec.instructor.toUpperCase().trim(),
    termSortKey(year, semester), `${semester} ${year}`, rec.gpa * n, n, 1);
}

function finalize() {
  const out = {};
  for (const [courseKey, instrs] of courses) {
    const instructors = {};
    for (const [instrKey, terms] of instrs) {
      const list = [...terms.values()].sort((a, b) => b.termKey - a.termKey); // most recent first
      const oSum = list.reduce((s, t) => s + t.sum, 0);
      const oN   = list.reduce((s, t) => s + t.n, 0);
      if (oN === 0) continue;
      instructors[instrKey] = {
        overallGpa: round3(oSum / oN),
        overallStudents: oN,
        terms: list.map((t) => ({ term: t.termLabel, gpa: round3(t.sum / t.n), students: t.n, sections: t.sections })),
      };
    }
    out[courseKey] = { instructors };
  }
  return out;
}

/** Seed `courses` from an existing file (incremental mode). Returns captured term labels. */
function loadExisting() {
  const captured = new Set();
  if (!fs.existsSync(OUT_PATH)) return { captured, prevScope: null };
  let prev;
  try { prev = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); } catch { return { captured, prevScope: null }; }
  for (const [courseKey, c] of Object.entries(prev.courses ?? {})) {
    for (const [instrKey, s] of Object.entries(c.instructors ?? {})) {
      for (const t of s.terms ?? []) {
        addTerm(courseKey, instrKey, parseTermLabel(t.term), t.term, t.gpa * t.students, t.students, t.sections ?? 0);
        captured.add(t.term);
      }
    }
  }
  for (const tl of prev.scrapedTerms ?? []) captured.add(tl);
  return { captured, prevScope: prev.scope ?? null };
}

// ---- Main -----------------------------------------------------------------
async function main() {
  const { captured: alreadyCaptured, prevScope } = INCREMENTAL ? loadExisting() : { captured: new Set(), prevScope: null };
  console.log(`Scraping grade distributions: colleges=[${COLLEGES}] years=[${YEARS}] semesters=[${SEMESTERS}]${INCREMENTAL ? ' (incremental)' : ''}`);
  if (INCREMENTAL) console.log(`Already captured ${alreadyCaptured.size} term(s); will fetch only new ones.`);

  let pdfCount = 0, recCount = 0, skipped = 0;
  const capturedTerms = new Set(alreadyCaptured); // union of old + newly scraped

  for (const year of YEARS) {
    for (const sem of SEMESTERS) {
      const termLabel = `${sem} ${year}`;
      if (INCREMENTAL && alreadyCaptured.has(termLabel)) { console.log(`  ${termLabel} — already captured, skipping`); continue; }
      let termGotPdf = false;
      for (const college of COLLEGES) {
        process.stdout.write(`  ${termLabel} ${college} ... `);
        try {
          const { status, buffer } = await fetchReport(year, sem, college);
          if (status !== 200 || !isPdf(buffer)) { console.log(`skip (status ${status}, ${isPdf(buffer) ? 'pdf' : 'no report'})`); skipped += 1; continue; }
          const recs = await parseGradeReportPdf(buffer);
          for (const rec of recs) addRecord(rec, year, sem);
          pdfCount += 1; recCount += recs.length; termGotPdf = true;
          console.log(`${recs.length} sections`);
        } catch (err) {
          console.log(`error: ${err.message}`);
          skipped += 1;
        }
      }
      // Only mark a term captured once at least one college returned a report —
      // a term with no PDFs yet (grades not posted) is left out so a later run retries it.
      if (termGotPdf) capturedTerms.add(termLabel);
    }
  }

  const out = finalize();
  const years = [...new Set([...capturedTerms].map((l) => l.split(' ')[1]))].sort();
  const colleges = [...new Set([...(prevScope?.colleges ?? []), ...COLLEGES])];
  const semesters = [...new Set([...(prevScope?.semesters ?? []), ...SEMESTERS])];
  const payload = {
    generatedAt: new Date().toISOString(),
    scope: { colleges, years, semesters },
    scrapedTerms: [...capturedTerms].sort((a, b) => parseTermLabel(b) - parseTermLabel(a)),
    courseCount: Object.keys(out).length,
    courses: out,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload));
  console.log(`\nDone. ${pdfCount} PDFs fetched this run, ${recCount} section rows, ${skipped} skipped.`);
  console.log(`Captured terms: ${payload.scrapedTerms.length} (${payload.scrapedTerms[0] ?? 'none'} … ${payload.scrapedTerms[payload.scrapedTerms.length - 1] ?? 'none'}).`);
  console.log(`Courses with data: ${payload.courseCount}. Written to ${OUT_PATH} (${(fs.statSync(OUT_PATH).size / 1024).toFixed(0)} KB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
