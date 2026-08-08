/**
 * transcriptPdfParser.js
 *
 * Client-side PDF parsing using pdfjs-dist.
 *
 * Extraction strategy: table-header anchoring.
 * Every term section in the TAMU transcript has a header row:
 *   Subj | No. | Course Title | Grade | Cred | Pts | R
 * We find each such header, use "Subj" x as the left bound and "R" x as the
 * right bound of that table, then collect rows below until "Ehrs:" or "Term Totals".
 * This handles two-column pages correctly because left-column and right-column
 * tables have different "R" x-positions — we never read across the gutter.
 *
 * Sections from left-column tables are output before right-column tables so
 * the text parser sees "TRANSFER CREDITS..." before institution courses.
 */

import { parseTranscriptText, parseDegreePlanText } from './transcriptParser';

let pdfJsPromise = null;

async function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = import('pdfjs-dist').then((module) => {
      if (!module.GlobalWorkerOptions.workerSrc) {
        module.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url
        ).href;
      }
      return module;
    });
  }
  return pdfJsPromise;
}

// ---------------------------------------------------------------------------
// Row builder — groups PDF text items into horizontal rows by y-position
// ---------------------------------------------------------------------------

function buildRows(items, yTol = 2) {
  const positioned = items
    .map((item) => ({
      x: item.transform[4],
      y: item.transform[5],
      text: String(item.str ?? '').trim(),
    }))
    .filter((item) => item.text);

  const buckets = [];
  for (const item of positioned) {
    const bucket = buckets.find((b) => Math.abs(b.y - item.y) <= yTol);
    if (bucket) { bucket.items.push(item); continue; }
    buckets.push({ y: item.y, items: [item] });
  }

  // Sort top → bottom (PDF y-axis increases upward, so descending y = top first)
  return buckets
    .sort((a, b) => b.y - a.y)
    .map((b) => ({ y: b.y, items: b.items.sort((a, c) => a.x - c.x) }));
}

// ---------------------------------------------------------------------------
// Section-based page extraction
// ---------------------------------------------------------------------------

/**
 * Extract text from a single PDF page using table-header anchoring.
 *
 * For each table header row found (identified by "Subj"+"No."+"Grade"+"R"):
 *   1. Determine x-range: leftX = Subj.x − buffer, rightX = R.x + buffer
 *   2. Collect context rows above the header (within x-range, since the
 *      previous same-column section ended)
 *   3. Collect course rows below the header until "Ehrs:" or "Term Totals"
 *
 * Sections are then sorted left-column first so transfer credit section labels
 * precede institution section labels in the final text.
 */
function extractPageBySections(items) {
  const rows = buildRows(items);
  if (!rows.length) return '';

  const X_BUF = 10; // extra x pixels to absorb minor alignment jitter

  // --- Find table header rows ---
  // A header row contains 'R' (standalone) AND at least one of 'No.' / 'Grade'
  const tableHeaders = [];
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    const textSet = new Set(row.items.map((it) => it.text));
    if (!textSet.has('R') || (!textSet.has('No.') && !textSet.has('Grade'))) continue;

    const subjItem = row.items.find((it) => it.text === 'Subj');
    const rItem    = row.items.find((it) => it.text === 'R');
    if (!rItem) continue;

    const leftX  = (subjItem ?? row.items[0]).x - X_BUF;
    const rightX = rItem.x + X_BUF;
    tableHeaders.push({ ri, leftX, rightX });
  }

  // No table structure on this page — fall back to simple row join
  if (!tableHeaders.length) {
    return rows
      .map((r) => r.items.map((i) => i.text).join(' ').trim())
      .filter(Boolean)
      .join('\n');
  }

  // --- Helpers ---

  // Two headers belong to the same column if their x-ranges overlap significantly
  const sameColumn = (a, b) => {
    const overlap = Math.min(a.rightX, b.rightX) - Math.max(a.leftX, b.leftX);
    return overlap > Math.min(a.rightX - a.leftX, b.rightX - b.leftX) * 0.4;
  };

  // Find the row index of the "Ehrs:" terminator for a section
  const findEhrsRowIdx = (startRi, leftX, rightX) => {
    for (let j = startRi; j < rows.length; j++) {
      const inRange = rows[j].items.filter(
        (it) => it.x >= leftX - X_BUF && it.x <= rightX + X_BUF
      );
      if (inRange.some((it) => it.text.startsWith('Ehrs:'))) return j;
    }
    return rows.length; // section has no Ehrs: (last section on page)
  };

  // --- Build one text section per table header ---
  const sections = []; // { leftX, lines[] }

  for (let hi = 0; hi < tableHeaders.length; hi++) {
    const { ri: hri, leftX, rightX } = tableHeaders[hi];

    // Where does context for this section start?
    // Go back to find the previous header in the SAME column and where it ended.
    let contextStart = 0;
    for (let phi = hi - 1; phi >= 0; phi--) {
      if (sameColumn(tableHeaders[hi], tableHeaders[phi])) {
        const prevEhrs = findEhrsRowIdx(
          tableHeaders[phi].ri + 1,
          tableHeaders[phi].leftX,
          tableHeaders[phi].rightX
        );
        contextStart = prevEhrs + 1;
        break;
      }
    }

    const lines = [];

    // Context: rows from contextStart up to (not including) the header row,
    // filtered to this table's x-range
    for (let j = contextStart; j < hri; j++) {
      const inRange = rows[j].items.filter(
        (it) => it.x >= leftX - X_BUF && it.x <= rightX + X_BUF
      );
      if (!inRange.length) continue;
      lines.push(inRange.map((it) => it.text).join(' ').trim());
    }

    // Pre-compute the row index of the next same-column header.
    // This is the hard upper bound for the course rows loop — prevents
    // bleeding into the next section on single-column pages where
    // multiple term sections share the same x-range.
    const nextSameColHri = tableHeaders
      .slice(hi + 1)
      .filter((th) => sameColumn(tableHeaders[hi], th))
      .reduce((min, th) => Math.min(min, th.ri), rows.length);

    // Course rows: from header+1 downward until next same-col header, "Ehrs:", or "Term Totals"
    for (let j = hri + 1; j < nextSameColHri; j++) {
      const inRange = rows[j].items.filter(
        (it) => it.x >= leftX - X_BUF && it.x <= rightX + X_BUF
      );
      if (!inRange.length) continue;
      const lineText = inRange.map((it) => it.text).join(' ').trim();
      if (lineText.startsWith('Ehrs:') || lineText.startsWith('Term Totals')) break;
      lines.push(lineText);
    }

    sections.push({ leftX, lines });
  }

  // Sort: left-column sections first (smaller leftX), then right-column.
  // JavaScript sort is stable (ES2019+), so sections within the same column
  // keep their original top→bottom order.
  sections.sort((a, b) => {
    if (Math.abs(a.leftX - b.leftX) < 50) return 0; // same column — preserve order
    return a.leftX - b.leftX;
  });

  return sections
    .map((s) => s.lines.join('\n'))
    .filter(Boolean)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a TAMU transcript or degree-plan PDF file.
 *
 * @param {File} file — A File object (from <input type="file">)
 */
export async function parseTranscriptFile(file) {
  if (!file) throw new Error('No file provided.');

  const pdfJs = await loadPdfJs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfJs.getDocument({ data: buffer }).promise;

  const pageTexts = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    pageTexts.push(extractPageBySections(content.items));
  }

  const text = pageTexts.filter(Boolean).join('\n\n');

  return text.includes('PLANNED COURSES')
    ? parseDegreePlanText(text)
    : parseTranscriptText(text);
}


