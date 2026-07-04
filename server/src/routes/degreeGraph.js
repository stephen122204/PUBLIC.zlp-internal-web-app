'use strict';
/**
 * GET /api/degree-graph/:programId
 * GET /api/degree-graph/engineering-programs
 *
 * Developer-only routes for triggering a live rebuild are removed in this
 * public repo — see README for why.
 */
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getDegreeRequirementGraph } = require('../lib/degreeGraphBuilder');
const { listEngineeringPrograms } = require('../lib/engineeringPrograms');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/degree-graph/engineering-programs
// Returns the list of College of Engineering programs from academic-programs.json
// ---------------------------------------------------------------------------
router.get('/engineering-programs', requireAuth, (_req, res) => {
  try {
    return res.json({ programs: listEngineeringPrograms() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/degree-graph/:programId
// Auth: any logged-in user
// ---------------------------------------------------------------------------
router.get('/:programId', requireAuth, async (req, res) => {
  try {
    const programId = decodeURIComponent(req.params.programId);
    const graph = await getDegreeRequirementGraph(programId);
    return res.json({ graph });
  } catch (err) {
    const status = err.statusCode ?? 500;
    console.error('[degree-graph GET]', err.message);
    return res.status(status).json({ error: err.message });
  }
});

module.exports = router;
