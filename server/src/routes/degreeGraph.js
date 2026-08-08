'use strict';
/**
 * GET  /api/degree-graph/:programId
 * POST /api/degree-graph/developer/:programId/refresh  (developer only)
 * POST /api/degree-graph/developer/build-engineering   (developer only)
 * GET  /api/degree-graph/engineering-programs          (auth required)
 */
const express = require('express');
const { requireAuth, requireDeveloper } = require('../middleware/auth');
const {
  getDegreeRequirementGraph,
  buildDegreeRequirementGraph,
  scrapeGraphFromCatalog,
  clearMemCache,
  invalidateGeneratedGraphsCache,
} = require('../lib/degreeGraphBuilder');
const { listEngineeringPrograms } = require('../lib/engineeringPrograms');
const DegreeRequirementGraph = require('../models/DegreeRequirementGraph');

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
// POST /api/degree-graph/developer/build-engineering
// Builds (or rebuilds) degree graphs for all College of Engineering programs
// by scraping the TAMU catalog and persisting to MongoDB.
// Auth: developer only
// ---------------------------------------------------------------------------
router.post('/developer/build-engineering', requireDeveloper, async (req, res) => {
  const programs = listEngineeringPrograms().filter((p) => !p.hasDetailedPlan);
  const results = [];
  let succeeded = 0;
  let failed = 0;

  // Stream-friendly: don't hold the connection open for minutes;
  // accept a ?async=true query to fire-and-forget.
  if (req.query.async === 'true') {
    res.json({ message: 'Build started asynchronously.', totalPrograms: programs.length });
  }

  for (const prog of programs) {
    const programId = prog.id;
    try {
      clearMemCache(programId);
      await DegreeRequirementGraph.deleteOne({ programId });

      const graph = await scrapeGraphFromCatalog(programId);
      await DegreeRequirementGraph.findOneAndUpdate(
        { programId },
        { ...graph, generatedAt: new Date() },
        { upsert: true, new: true },
      );

      results.push({ programId, status: 'ok', nodes: graph.nodes.length, edges: graph.edges.length, warnings: graph.warnings });
      succeeded++;
    } catch (err) {
      results.push({ programId, status: 'error', error: err.message });
      failed++;
    }
  }

  // Bust the in-process generated-graphs cache so new data is picked up
  invalidateGeneratedGraphsCache();

  if (!res.headersSent) {
    return res.json({
      totalPrograms: programs.length,
      succeeded,
      failed,
      results,
    });
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

// ---------------------------------------------------------------------------
// POST /api/degree-graph/developer/:programId/refresh
// Auth: developer only
// ---------------------------------------------------------------------------
router.post('/developer/:programId/refresh', requireDeveloper, async (req, res) => {
  try {
    const programId = decodeURIComponent(req.params.programId);
    clearMemCache(programId);
    await DegreeRequirementGraph.deleteOne({ programId });

    const graph = await buildDegreeRequirementGraph(programId);
    await DegreeRequirementGraph.findOneAndUpdate(
      { programId },
      { ...graph, generatedAt: new Date() },
      { upsert: true, new: true },
    );

    return res.json({ graph, message: 'Graph refreshed successfully.' });
  } catch (err) {
    const status = err.statusCode ?? 500;
    console.error('[degree-graph refresh]', err.message);
    return res.status(status).json({ error: err.message });
  }
});

module.exports = router;
