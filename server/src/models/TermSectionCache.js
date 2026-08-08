'use strict';
const mongoose = require('mongoose');

// Persistent cache of a term's mapped course sections. Howdy's /api/course-sections
// returns the ENTIRE term (~23 MB, all courses) with no server-side filtering, so we
// fetch it once, map to compact rows (~4.5 MB), and store the whole term as one document.
// Serverless instances share this instead of re-fetching 23 MB on every cold start.
// `rows` is Mixed to skip per-row Mongoose casting on ~14k entries.
const schema = new mongoose.Schema(
  {
    termCode:  { type: String, required: true, unique: true },
    rows:      { type: mongoose.Schema.Types.Mixed, default: [] },
    fetchedAt: { type: Date, default: Date.now },
  },
  { minimize: false }
);

module.exports = mongoose.models.TermSectionCache || mongoose.model('TermSectionCache', schema);
