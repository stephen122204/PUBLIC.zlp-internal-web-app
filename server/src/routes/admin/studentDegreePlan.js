'use strict';
/**
 * Admin / developer access to student degree plans.
 *
 * GET /api/admin/students/:studentId/degree-plan
 * PUT /api/admin/students/:studentId/degree-plan
 */
const express = require('express');
const mongoose = require('mongoose');
const { requireAdmin } = require('../../middleware/auth');
const StudentSemesterPlan = require('../../models/StudentSemesterPlan');
const StudentPlannedCourse = require('../../models/StudentPlannedCourse');
const User = require('../../models/User');
const CohortMember = require('../../models/CohortMember');

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers (duplicated from semesterPlan.js to keep routes independent)
// ---------------------------------------------------------------------------
function normCode(s) {
  const m = String(s ?? '').toUpperCase().trim().match(/\b([A-Z]{3,5})\s*(\d{3}[A-Z]?)\b/u);
  return m ? `${m[1]} ${m[2]}` : null;
}

function shapeSemesterList(semesters, coursesBySem) {
  return semesters.map((sem) => ({
    id:         sem._id.toString(),
    label:      sem.label,
    year:       sem.year ?? null,
    term:       sem.term,
    termCode:   sem.termCode ?? null,
    orderIndex: sem.orderIndex,
    status:     sem.status,
    notes:      sem.notes ?? '',
    courses:    (coursesBySem[sem._id.toString()] ?? []).map(shapeCourse),
  }));
}

function shapeCourse(c) {
  return {
    id:               c._id.toString(),
    subject:          c.subject,
    number:           c.number,
    code:             c.code,
    title:            c.title ?? '',
    creditHours:      c.creditHours ?? null,
    status:           c.status,
    transfer:         c.transfer ?? false,
    honors:           c.honors ?? false,
    writingRequirement: c.writingRequirement ?? '',
    source:           c.source ?? 'manual',
    passed:           c.passed ?? true,
    needsRetake:      c.needsRetake ?? false,
    notes:            c.notes ?? '',
  };
}

// ---------------------------------------------------------------------------
// GET /api/admin/students/:studentId/degree-plan
// ---------------------------------------------------------------------------
router.get('/students/:studentId/degree-plan', requireAdmin, async (req, res) => {
  try {
    const { studentId } = req.params;
    const { cohortId } = req.query;

    if (!mongoose.isValidObjectId(studentId)) {
      return res.status(400).json({ error: 'Invalid studentId.' });
    }

    // Resolve cohortId — either from query or from membership
    let resolvedCohortId = cohortId;
    if (!resolvedCohortId) {
      const mem = await CohortMember.findOne({ userId: studentId, status: 'active' }).lean();
      if (!mem) return res.json({ semesters: [] });
      resolvedCohortId = mem.cohortId;
    }

    const semesters = await StudentSemesterPlan.find(
      { userId: studentId, cohortId: resolvedCohortId },
      null,
      { sort: { orderIndex: 1 } }
    ).lean();

    if (semesters.length === 0) return res.json({ semesters: [] });

    const semIds = semesters.map((s) => s._id);
    const courses = await StudentPlannedCourse.find({ semesterPlanId: { $in: semIds } }).lean();

    const byId = {};
    for (const c of courses) {
      const k = c.semesterPlanId.toString();
      if (!byId[k]) byId[k] = [];
      byId[k].push(c);
    }

    return res.json({ semesters: shapeSemesterList(semesters, byId) });
  } catch (err) {
    console.error('[admin degree-plan GET]', err);
    return res.status(500).json({ error: 'Failed to load student degree plan.' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/admin/students/:studentId/degree-plan
// ---------------------------------------------------------------------------
router.put('/students/:studentId/degree-plan', requireAdmin, async (req, res) => {
  try {
    const { studentId } = req.params;
    const { cohortId, semesters: incomingSemesters } = req.body;

    if (!mongoose.isValidObjectId(studentId)) {
      return res.status(400).json({ error: 'Invalid studentId.' });
    }
    if (!cohortId) return res.status(400).json({ error: 'cohortId is required.' });
    if (!Array.isArray(incomingSemesters)) {
      return res.status(400).json({ error: 'semesters must be an array.' });
    }

    const userId   = new mongoose.Types.ObjectId(studentId);
    const cohortOId = new mongoose.Types.ObjectId(cohortId);
    const editorId = req.user._id;

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const existing = await StudentSemesterPlan.find({ userId, cohortId: cohortOId }, '_id', { session });
        const existingIds = existing.map((s) => s._id);
        if (existingIds.length > 0) {
          await StudentPlannedCourse.deleteMany({ semesterPlanId: { $in: existingIds } }, { session });
          await StudentSemesterPlan.deleteMany({ userId, cohortId: cohortOId }, { session });
        }
        for (let i = 0; i < incomingSemesters.length; i++) {
          const s = incomingSemesters[i];
          const label = String(s.label ?? `Semester ${i + 1}`).slice(0, 100);
          const status = ['completed', 'in_progress', 'planned'].includes(s.status) ? s.status : 'planned';
          const term   = ['Fall', 'Spring', 'Summer', 'Other'].includes(s.term) ? s.term : 'Other';
          const [newSem] = await StudentSemesterPlan.create([{
            userId, cohortId: cohortOId, label,
            year: s.year ?? null, term,
            termCode: s.termCode ? String(s.termCode).slice(0, 20) : null,
            orderIndex: typeof s.orderIndex === 'number' ? s.orderIndex : i,
            status, notes: s.notes ? String(s.notes).slice(0, 500) : '',
          }], { session });
          for (const c of (s.courses ?? [])) {
            const code = normCode(c.code ?? `${c.subject} ${c.number}`);
            if (!code) continue;
            const [subj, num] = code.split(' ');
            const src = ['manual','screenshot_import','transcript_import','admin_edit','developer_edit'].includes(c.source)
              ? c.source : 'admin_edit';
            await StudentPlannedCourse.create([{
              userId, cohortId: cohortOId, semesterPlanId: newSem._id,
              subject: subj, number: num, code,
              title: c.title ? String(c.title).slice(0, 200) : '',
              creditHours: c.creditHours != null ? Number(c.creditHours) : null,
              status: ['completed','in_progress','planned'].includes(c.status) ? c.status : status,
              transfer: !!c.transfer, honors: !!c.honors,
              writingRequirement: c.writingRequirement ? String(c.writingRequirement).slice(0, 100) : '',
              source: src,
              passed: c.passed !== false, needsRetake: !!c.needsRetake,
              notes: c.notes ? String(c.notes).slice(0, 500) : '',
              updatedBy: editorId,
            }], { session });
          }
        }
      });
    } finally {
      session.endSession();
    }

    // Reload and return
    const semesters = await StudentSemesterPlan.find(
      { userId, cohortId: cohortOId }, null, { sort: { orderIndex: 1 } }
    ).lean();
    const semIds = semesters.map((s) => s._id);
    const courses = await StudentPlannedCourse.find({ semesterPlanId: { $in: semIds } }).lean();
    const byId = {};
    for (const c of courses) {
      const k = c.semesterPlanId.toString();
      if (!byId[k]) byId[k] = [];
      byId[k].push(c);
    }
    return res.json({ semesters: shapeSemesterList(semesters, byId) });
  } catch (err) {
    console.error('[admin degree-plan PUT]', err);
    return res.status(500).json({ error: 'Failed to save student degree plan.' });
  }
});

module.exports = router;
