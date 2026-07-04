'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const { requireAdmin } = require('../../middleware/auth');

const router = express.Router();

// Precompute unique terms at first request
let TERMS = null;

function buildTerms() {
  if (TERMS) return TERMS;
  const dataPath = path.join(__dirname, '../../../data/catalog-index.json');
  const parsed = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const rows = Array.isArray(parsed) ? parsed : (parsed.entries || []);
  // Filter: College Station campus, Fall or Spring semesters only
  // Use plain object (not Map) to avoid a Node 26 Map-iteration bug
  const seen = {};
  for (let i = 0; i < rows.length; i++) {
    const entry = rows[i];
    if (
      entry.campus === 'college-station' &&
      /^(Fall|Spring)\s/i.test(entry.termDescription) &&
      !seen[entry.termCode]
    ) {
      seen[entry.termCode] = {
        termCode: entry.termCode,
        term: entry.termDescription,
        termDescription: entry.termDescription,
        campus: entry.campus,
      };
    }
  }
  // Sort newest first, then keep only the last 3 years relative to the newest term
  const sorted = Object.values(seen).sort((a, b) => b.termCode.localeCompare(a.termCode));
  const latestYear = sorted.length ? parseInt(sorted[0].termCode.substring(0, 4), 10) : new Date().getFullYear();
  TERMS = sorted.filter(t => parseInt(t.termCode.substring(0, 4), 10) >= latestYear - 2);
  return TERMS;
}

// ---------------------------------------------------------------------------
// GET /api/admin/term-options
// Returns unique term codes available in the catalog index, newest first.
// ---------------------------------------------------------------------------
router.get('/term-options', requireAdmin, (_req, res) => {
  try {
    return res.json({ terms: buildTerms() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
