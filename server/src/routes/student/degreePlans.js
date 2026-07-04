'use strict';
const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const { listDegreePlans, getDegreePlan } = require('../../lib/degreePlanData');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/student/degree-plans
// ---------------------------------------------------------------------------
router.get('/', requireAuth, (_req, res) => {
  try {
    const result = listDegreePlans();
    return res.json(result);
  } catch (err) {
    console.error('[degree-plans]', err);
    return res.status(500).json({ error: 'Failed to load degree plans.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/student/degree-plans/:planId
// ---------------------------------------------------------------------------
router.get('/:planId', requireAuth, (req, res) => {
  try {
    const plan = getDegreePlan(req.params.planId);
    return res.json({ plan });
  } catch (err) {
    const status = err.statusCode === 404 ? 404 : 500;
    return res.status(status).json({ error: err.message });
  }
});

module.exports = router;
