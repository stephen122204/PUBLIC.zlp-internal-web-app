'use strict';

const express = require('express');
const Cohort = require('../../models/Cohort');
const CohortMember = require('../../models/CohortMember');
const User = require('../../models/User');
const { resolveStudentContext } = require('../../middleware/auth');
const { normalizeJoinCode, validateJoinCodeFormat } = require('../../lib/joinCode');

const router = express.Router();

// POST /api/student/join-cohort
router.post('/join-cohort', resolveStudentContext, async (req, res) => {
  try {
    const raw = req.body.code;
    if (!raw) return res.status(400).json({ error: 'Enter a valid 6-character code.' });
    const code = normalizeJoinCode(raw);
    if (!validateJoinCodeFormat(code)) {
      return res.status(400).json({ error: 'Enter a valid 6-character code.' });
    }

    const cohort = await Cohort.findOne({ joinCode: code }).lean();
    if (!cohort) return res.status(404).json({ error: 'No cohort found for that code.' });
    if (!cohort.joinCodeEnabled || (cohort.joinCodeExpiresAt && new Date() > cohort.joinCodeExpiresAt)) {
      return res.status(400).json({ error: 'This cohort code is not currently active.' });
    }
    if (cohort.archivedAt) {
      return res.status(400).json({ error: 'This cohort is archived and cannot be joined.' });
    }

    // Check if already in any active cohort
    const existing = await CohortMember.findOne({ userId: req.studentUser._id, status: 'active' }).lean();
    if (existing) {
      if (String(existing.cohortId) === String(cohort._id)) {
        // Already in this exact cohort — return success idempotently
        return res.json({
          success: true,
          cohort: { id: cohort._id, name: cohort.name, term: cohort.term ?? null, status: 'active' },
        });
      }
      return res.status(409).json({ error: 'You are already assigned to a cohort.' });
    }

    // Create membership
    await CohortMember.create({
      cohortId:  cohort._id,
      userId:    req.studentUser._id,
      status:    'active',
      joinedAt:  new Date(),
      joinedVia: 'join_code',
    });

    // Set cohortId on the student (demo or real)
    await User.findByIdAndUpdate(req.studentUser._id, { cohortId: cohort._id });

    res.json({
      success: true,
      cohort: { id: cohort._id, name: cohort.name, term: cohort.term ?? null, status: 'active' },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/student/cohort-status
router.get('/cohort-status', resolveStudentContext, async (req, res) => {
  try {
    const membership = await CohortMember.findOne({ userId: req.studentUser._id, status: 'active' })
      .populate('cohortId', 'name term termCode archivedAt')
      .lean();

    if (!membership) {
      return res.json({ hasCohort: false, cohort: null, membership: null });
    }
    res.json({
      hasCohort:  true,
      cohort:     membership.cohortId,
      membership: {
        status:    membership.status,
        joinedAt:  membership.joinedAt,
        joinedVia: membership.joinedVia ?? 'manual',
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
