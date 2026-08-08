'use strict';
const express  = require('express');
const router   = express.Router();
const mongoose = require('mongoose');

const { requireAdmin } = require('../../middleware/auth');
const { runAllZlpModes, buildExcelWorkbook, buildAlgorithmDiagnostic, buildWindowDebug, buildWindowCountDebug } = require('../../lib/zlpAlgorithm');
const AlgorithmRun = require('../../models/AlgorithmRun');

// POST /api/admin/algorithm/run
// Runs both required_only and required_plus_preferred modes, returns both run summaries.
router.post('/algorithm/run', requireAdmin, async (req, res) => {
  const { cohortId, schedulingCycleId, includeDraftSubmissions = false, legacyMode = false, params = {} } = req.body;

  if (!cohortId || !schedulingCycleId) {
    return res.status(400).json({ error: 'cohortId and schedulingCycleId are required.' });
  }

  if (!mongoose.Types.ObjectId.isValid(cohortId) || !mongoose.Types.ObjectId.isValid(schedulingCycleId)) {
    return res.status(400).json({ error: 'Invalid cohortId or schedulingCycleId.' });
  }

  try {
    const { requiredOnlyRun, preferredRun, requiredPlusPreferredRun } = await runAllZlpModes({
      cohortId,
      schedulingCycleId,
      includeDraftSubmissions: Boolean(includeDraftSubmissions),
      legacyMode:              Boolean(legacyMode),
      userId: req.user._id,
      params,
    });

    // Return summaries (not full results) to keep response small
    const serializeRun = (run) => ({
      _id:              run._id,
      mode:             run.mode,
      status:           run.status,
      createdAt:        run.createdAt,
      startedAt:        run.startedAt,
      completedAt:      run.completedAt,
      parameters:       run.parameters,
      summary:          run.summary,
      warnings:         run.warnings,
      errorMessage:     run.errorMessage,
    });

    return res.json({
      requiredOnlyRun:            serializeRun(requiredOnlyRun),
      preferredRun:               serializeRun(preferredRun),
      requiredPlusPreferredRun:   serializeRun(requiredPlusPreferredRun),
    });
  } catch (err) {
    console.error('[algorithm/run] error:', err);
    return res.status(500).json({ error: err.message ?? 'Algorithm run failed.' });
  }
});

// GET /api/admin/algorithm/runs?cohortId=&schedulingCycleId=&limit=20
// Returns a list of recent runs (summaries only, no full results).
router.get('/algorithm/runs', requireAdmin, async (req, res) => {
  const { cohortId, schedulingCycleId, limit = 20 } = req.query;

  const filter = {};
  if (cohortId)          filter.cohortId          = cohortId;
  if (schedulingCycleId) filter.schedulingCycleId = schedulingCycleId;

  try {
    const runs = await AlgorithmRun.find(filter, {
      // Exclude the heavy results field
      results: 0,
    }).sort({ createdAt: -1 }).limit(Number(limit)).lean();

    return res.json({ runs });
  } catch (err) {
    console.error('[algorithm/runs] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/algorithm/runs/:runId
// Returns the full run (including results).
router.get('/algorithm/runs/:runId', requireAdmin, async (req, res) => {
  const { runId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(runId)) {
    return res.status(400).json({ error: 'Invalid runId.' });
  }

  try {
    const run = await AlgorithmRun.findById(runId).lean();
    if (!run) return res.status(404).json({ error: 'Run not found.' });
    return res.json({ run });
  } catch (err) {
    console.error('[algorithm/runs/:id] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/algorithm/runs/:runId/download
// Sends an Excel file for the given run as a buffer.
router.get('/algorithm/runs/:runId/download', requireAdmin, async (req, res) => {
  const { runId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(runId)) {
    return res.status(400).json({ error: 'Invalid runId.' });
  }

  try {
    const run = await AlgorithmRun.findById(runId).lean();
    if (!run) return res.status(404).json({ error: 'Run not found.' });
    if (run.status !== 'completed') {
      return res.status(400).json({ error: `Run status is "${run.status}", cannot export.` });
    }

    const wb = await buildExcelWorkbook(run);

    // writeBuffer() can hang indefinitely on large workbooks — race against a 2-min timeout
    const buffer = await Promise.race([
      wb.xlsx.writeBuffer(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Excel generation timed out after 2 minutes')), 120000)
      ),
    ]);

    const mode     = run.mode === 'required_only' ? 'required'
                   : run.mode === 'preferred'     ? 'preferred'
                   : 'sections-preferred';
    const filename = `zlp-algorithm-${mode}-${run._id}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    console.error('[algorithm/runs/:id/download] error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// GET /api/admin/algorithm/debug-input?cohortId=...&schedulingCycleId=...
// Returns a comprehensive diagnostic report without running the algorithm.
router.get('/algorithm/debug-input', requireAdmin, async (req, res) => {
  const { cohortId, schedulingCycleId } = req.query;

  if (!cohortId || !schedulingCycleId) {
    return res.status(400).json({ error: 'cohortId and schedulingCycleId query params are required.' });
  }
  if (!mongoose.Types.ObjectId.isValid(cohortId) || !mongoose.Types.ObjectId.isValid(schedulingCycleId)) {
    return res.status(400).json({ error: 'Invalid cohortId or schedulingCycleId.' });
  }

  try {
    const report = await buildAlgorithmDiagnostic({ cohortId, schedulingCycleId });
    return res.json(report);
  } catch (err) {
    console.error('[algorithm/debug-input] error:', err);
    return res.status(500).json({ error: err.message ?? 'Diagnostic failed.' });
  }
});

// POST /api/admin/algorithm/window-debug
// Re-evaluates one specific ZLP window with full per-student debug output.
// Useful for diagnosing why a student hits the self-conflict search limit.
router.post('/algorithm/window-debug', requireAdmin, async (req, res) => {
  const { cohortId, schedulingCycleId, mode = 'required_only', day, startMinutes } = req.body;

  if (!cohortId || !schedulingCycleId || !day || startMinutes === undefined) {
    return res.status(400).json({ error: 'cohortId, schedulingCycleId, day, and startMinutes are required.' });
  }
  if (!mongoose.Types.ObjectId.isValid(cohortId) || !mongoose.Types.ObjectId.isValid(schedulingCycleId)) {
    return res.status(400).json({ error: 'Invalid cohortId or schedulingCycleId.' });
  }
  if (!['M', 'T', 'W', 'R', 'F'].includes(day)) {
    return res.status(400).json({ error: 'day must be one of M, T, W, R, F.' });
  }

  try {
    const result = await buildWindowDebug({
      cohortId,
      schedulingCycleId,
      mode,
      day,
      startMinutes: Number(startMinutes),
    });
    return res.json(result);
  } catch (err) {
    console.error('[algorithm/window-debug] error:', err);
    return res.status(500).json({ error: err.message ?? 'Window debug failed.' });
  }
});

// POST /api/admin/algorithm/window-count-debug
// Loads an existing run and re-evaluates one window with full per-section overlap detail.
// Answers "why does window T 12:35–14:15 show 0 conflicts?"
router.post('/algorithm/window-count-debug', requireAdmin, async (req, res) => {
  const { runId, day, startMinutes } = req.body;

  if (!runId || !day || startMinutes === undefined) {
    return res.status(400).json({ error: 'runId, day, and startMinutes are required.' });
  }
  if (!mongoose.Types.ObjectId.isValid(runId)) {
    return res.status(400).json({ error: 'Invalid runId.' });
  }
  if (!['M', 'T', 'W', 'R', 'F'].includes(day)) {
    return res.status(400).json({ error: 'day must be one of M, T, W, R, F.' });
  }

  try {
    const result = await buildWindowCountDebug({
      runId,
      day,
      startMinutes: Number(startMinutes),
    });
    return res.json(result);
  } catch (err) {
    console.error('[algorithm/window-count-debug] error:', err);
    return res.status(500).json({ error: err.message ?? 'Window count debug failed.' });
  }
});

module.exports = router;
