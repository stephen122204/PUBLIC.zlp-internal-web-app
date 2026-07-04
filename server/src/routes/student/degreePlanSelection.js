'use strict';
const express = require('express');
const { resolveStudentContext } = require('../../middleware/auth');
const { getStudentActiveCohort } = require('../../lib/submissionHelpers');
const { getDegreePlan } = require('../../lib/degreePlanData');
const DegreePlanSelection = require('../../models/DegreePlanSelection');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/student/degree-plan-selection
// ---------------------------------------------------------------------------
router.get('/', resolveStudentContext, async (req, res) => {
  try {
    const cohort = await getStudentActiveCohort(req.studentUser._id);
    if (!cohort) return res.json({ selection: null });

    const sel = await DegreePlanSelection.findOne({
      userId: req.studentUser._id,
      cohortId: cohort._id,
    }).lean();

    return res.json({
      selection: sel
        ? { planId: sel.planId, planTitle: sel.planTitle, catalog: sel.catalog, updatedAt: sel.updatedAt }
        : null,
    });
  } catch (err) {
    console.error('[student/degree-plan-selection GET]', err);
    return res.status(500).json({ error: 'Failed to load selection.' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/student/degree-plan-selection
// Body: { planId }
// ---------------------------------------------------------------------------
router.put('/', resolveStudentContext, async (req, res) => {
  try {
    const { planId } = req.body;
    if (!planId) return res.status(400).json({ error: 'planId is required.' });

    // Validate plan exists
    let plan;
    try {
      plan = getDegreePlan(planId);
    } catch (e) {
      if (e.statusCode === 404) return res.status(404).json({ error: 'Degree plan not found.' });
      throw e;
    }

    const cohort = await getStudentActiveCohort(req.studentUser._id);
    if (!cohort) return res.status(400).json({ error: 'Not enrolled in any active cohort.' });

    const sel = await DegreePlanSelection.findOneAndUpdate(
      { userId: req.studentUser._id, cohortId: cohort._id },
      { planId, planTitle: plan.title, catalog: plan.catalog },
      { new: true, upsert: true }
    ).lean();

    return res.json({
      selection: {
        planId: sel.planId,
        planTitle: sel.planTitle,
        catalog: sel.catalog,
        updatedAt: sel.updatedAt,
      },
    });
  } catch (err) {
    console.error('[student/degree-plan-selection PUT]', err);
    return res.status(500).json({ error: 'Failed to save selection.' });
  }
});

module.exports = router;
