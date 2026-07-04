'use strict';
/**
 * Cross-listed / equivalent course lookup for the classifier.
 *
 * Loads data/cross-listings.json (built offline by scripts/build-cross-listings.mjs)
 * — the SAME course under multiple department codes (formal cross-listings like
 * CSCE 201/CYBR 201, plus identical-content equivalents like CSCE 421/STAT 421).
 * Taking any code in a group satisfies a requirement listing another.
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', '..', 'data', 'cross-listings.json');

let cache = null;
let cacheMtime = 0;
function loadMap() {
  // Reload when the file changes (after a refresh scrape) without a restart.
  let mtime = 0;
  try { mtime = fs.statSync(DATA_PATH).mtimeMs; } catch { /* not built yet */ }
  if (cache && mtime === cacheMtime) return cache;
  const map = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    for (const group of data.groups ?? []) {
      const norm = group.map((c) => String(c).toUpperCase().trim());
      for (const code of norm) {
        const set = map.get(code) ?? new Set();
        for (const other of norm) if (other !== code) set.add(other);
        map.set(code, set);
      }
    }
    cacheMtime = mtime;
  } catch { /* degrade gracefully */ }
  cache = map;
  return cache;
}

/** A code plus all its cross-listed equivalents (uppercase, normalized "SUBJ NNN"). */
function equivalentCodes(code) {
  const up = String(code ?? '').toUpperCase().trim();
  const eq = loadMap().get(up);
  return eq ? [up, ...eq] : [up];
}

/** Expand a list of codes to also include all cross-listed equivalents (deduped). */
function expandWithEquivalents(codes) {
  const out = new Set();
  for (const c of codes ?? []) for (const e of equivalentCodes(c)) out.add(e);
  return [...out];
}

module.exports = { equivalentCodes, expandWithEquivalents };
