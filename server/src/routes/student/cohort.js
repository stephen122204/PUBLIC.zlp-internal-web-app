'use strict';
const express = require('express');
const { resolveStudentContext } = require('../../middleware/auth');
const Cohort = require('../../models/Cohort');
const CohortMember = require('../../models/CohortMember');
const { getActiveSchedulingCycleForCohort, getCurrentCycleForCohort } = require('../../lib/submissionHelpers');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/student/cohort
// Returns the logged-in student's cohort and active scheduling cycle.
// ---------------------------------------------------------------------------
router.get('/', resolveStudentContext, async (req, res) => {
  try {
    const user = req.studentUser;

    // Admins in dev preview mode — no real cohort
    if (user.role === 'admin') {
      const devPreview = process.env.ENABLE_DEV_VIEW_SWITCH === 'true' &&
        (process.env.DEV_EMAILS || '').split(',').map((e) => e.trim()).includes(user.email);
      return res.json({
        cohort: null,
        activeCycle: null,
        devPreview: devPreview || true,
        message: 'Developer preview: no student cohort assigned.',
      });
    }

    const membership = await CohortMember.findOne({ userId: user._id, status: 'active' });
    if (!membership) {
      return res.json({ cohort: null, activeCycle: null });
    }

    const [cohort, cycle] = await Promise.all([
      Cohort.findById(membership.cohortId),
      getCurrentCycleForCohort(membership.cohortId),
    ]);

    if (!cohort) {
      return res.json({ cohort: null, activeCycle: null });
    }

    return res.json({
      cohort: {
        id: cohort._id,
        name: cohort.name,
        term: cohort.term ?? null,
        active: cohort.active,
      },
      activeCycle: cycle
        ? {
            id: cycle._id,
            name: cycle.name ?? null,
            term: cycle.term,
            termCode: cycle.termCode,
            submissionDeadline: cycle.submissionDeadline ?? null,
            submissionOpenAt: cycle.submissionOpenAt ?? null,
            status: cycle.status,
            activeForStudents: cycle.activeForStudents,
          }
        : null,
    });
  } catch (err) {
    console.error('[student/cohort]', err);
    return res.status(500).json({ error: 'Failed to load cohort.' });
  }
});

module.exports = router;

