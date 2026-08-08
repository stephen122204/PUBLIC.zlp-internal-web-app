'use strict';
/**
 * Parser for TAMU "Grade Distribution Report" PDFs.
 *
 * Source: https://web-as.tamu.edu/gradereports/  →  POST /gradereports/Home/ShowReportPage
 *   body: SelectedYear=2025&SelectedSemester=SPRING|SUMMER|FALL&SelectedCollege=EN
 *   returns: one PDF per college per semester (≈200+ pages).
 *
 * Each section is one fixed-width row:
 *   SECTION        A  B  C  D  F   A-F  GPA   I S U Q X TOTAL INSTRUCTOR
 *   AERO-201-500   12 16 11 3  0   42  2.880  0 0 0 0 0  42   SHRYOCK K
 *
 * We extract one record per section: { subject, course, section, gpa, afTotal, instructor }.
 * "COURSE TOTAL" / percentage rows are ignored.
 *
 * Parsing is build-time only (offline scraper); pdfjs-dist is a devDependency.
 */

const { getDocument } = require('pdfjs-dist/legacy/build/pdf.mjs');

// SECTION token like "AERO-201-500" or "CSCE-221-M01" (section can be alphanumeric).
const SECTION_RE = /^([A-Z]{2,5})-(\d{3}[A-Z]?)-([A-Z0-9]{2,4})$/;
// A GPA value (0.000–4.000).
const GPA_RE = /^[0-4]\.\d{3}$/;

/**
 * Rebuild text lines from a page's positioned glyph items (group by rounded Y,
 * order by X). The report is fixed-width so this reproduces each row faithfully.
 */
function pageItemsToLines(textContent) {
  const byY = new Map();
  for (const it of textContent.items) {
    const s = it.str;
    if (!s || !s.trim()) continue;
    const y = Math.round(it.transform[5]);
    if (!byY.has(y)) byY.set(y, []);
    byY.get(y).push({ s, x: it.transform[4] });
  }
  return [...byY.entries()]
    .sort((a, b) => b[0] - a[0]) // top-to-bottom
    .map(([, parts]) =>
      parts.sort((a, b) => a.x - b.x).map((p) => p.s).join(' ').replace(/\s+/g, ' ').trim()
    );
}

/**
 * Parse one section line into a record, or null if it isn't a section row.
 * Tokens: SECTION A B C D F AF_TOTAL GPA I S U Q X TOTAL INSTRUCTOR...
 */
function parseSectionLine(line) {
  const tok = line.split(/\s+/);
  const m = tok[0] && tok[0].match(SECTION_RE);
  if (!m) return null;

  // Find the GPA token (first 0-4.### after the section). The six numbers before
  // it are A,B,C,D,F,AF_TOTAL; everything after the next five ints is the instructor.
  const gpaIdx = tok.findIndex((t, i) => i > 0 && GPA_RE.test(t));
  if (gpaIdx < 7) return null; // need at least SECTION + A..F + AF_TOTAL before GPA

  const gpa = Number(tok[gpaIdx]);
  const afTotal = Number(tok[gpaIdx - 1]);
  if (!Number.isFinite(gpa)) return null;

  // Instructor = tokens after the trailing numeric columns (I S U Q X TOTAL).
  // Skip forward over up-to-6 integer columns following the GPA, then the rest is the name.
  let i = gpaIdx + 1;
  let intsSeen = 0;
  while (i < tok.length && intsSeen < 6 && /^\d+$/.test(tok[i])) { i += 1; intsSeen += 1; }
  const instructor = tok.slice(i).join(' ').trim() || null;

  return {
    subject: m[1],
    course: m[2],
    section: m[3],
    gpa,
    afTotal: Number.isFinite(afTotal) ? afTotal : null,
    instructor,
  };
}

/**
 * Parse a grade-distribution PDF buffer into section records.
 * @param {Buffer|Uint8Array} buffer
 * @returns {Promise<Array<{subject,course,section,gpa,afTotal,instructor}>>}
 */
async function parseGradeReportPdf(buffer) {
  // pdfjs requires a plain Uint8Array (it rejects Node Buffer specifically).
  const data = Buffer.isBuffer(buffer) ? Uint8Array.from(buffer) : new Uint8Array(buffer);
  const doc = await getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const records = [];
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const line of pageItemsToLines(content)) {
      const rec = parseSectionLine(line);
      if (rec) records.push(rec);
    }
    page.cleanup();
  }
  await doc.destroy();
  return records;
}

module.exports = { parseGradeReportPdf, parseSectionLine };
