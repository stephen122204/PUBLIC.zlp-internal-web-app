'use strict';
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const SchedulingCycle = require('../../models/SchedulingCycle');
const Cohort = require('../../models/Cohort');
const StudentSubmission = require('../../models/StudentSubmission');
const StudentCourseRequest = require('../../models/StudentCourseRequest');
const SectionPreference = require('../../models/SectionPreference');
const AlgorithmRun = require('../../models/AlgorithmRun');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/admin/cohorts/:cohortId/cycles
// By default excludes archived cycles. Pass ?showArchived=true to include them.
// ---------------------------------------------------------------------------
router.get('/cohorts/:cohortId/cycles', requireAdmin, async (req, res) => {
  try {
    const showArchived = req.query.showArchived === 'true';
    const filter = { cohortId: req.params.cohortId };
    if (!showArchived) {
      // Exclude both new-style (archived:true) and old-style (status:'archived') docs.
      filter.archived = { $ne: true };
      filter.status = { $ne: 'archived' };
    }
    const cycles = await SchedulingCycle.find(filter)
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ cycles });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/cohorts/:cohortId/cycles
// Body: { name?, term, termCode, submissionOpenAt?, submissionDeadline?, status? }
// ---------------------------------------------------------------------------
router.post('/cohorts/:cohortId/cycles', requireAdmin, async (req, res) => {
  try {
    const cohort = await Cohort.findById(req.params.cohortId);
    if (!cohort) return res.status(404).json({ error: 'Cohort not found.' });
    if (cohort.archivedAt) return res.status(400).json({ error: 'Cannot create scheduling cycles for an archived cohort.' });
    const { name, term, termCode, submissionOpenAt, submissionDeadline, status } = req.body;
    if (!term || !termCode) {
      return res.status(400).json({ error: 'term and termCode are required.' });
    }
    const allowedStatuses = ['draft', 'open', 'closed'];
    const resolvedStatus = allowedStatuses.includes(status) ? status : 'draft';
    const cycle = await SchedulingCycle.create({
      cohortId: req.params.cohortId,
      ...(name && { name: name.trim() }),
      term,
      termCode,
      ...(submissionOpenAt && { submissionOpenAt }),
      ...(submissionDeadline && { submissionDeadline }),
      status: resolvedStatus,
      archived: false,
      activeForStudents: false,
      createdBy: req.user._id,
    });
    return res.status(201).json({ cycle });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/cycles/:cycleId
// ---------------------------------------------------------------------------
router.patch('/cycles/:cycleId', requireAdmin, async (req, res) => {
  try {
    const existing = await SchedulingCycle.findById(req.params.cycleId);
    if (!existing) return res.status(404).json({ error: 'Cycle not found.' });
    if (existing.archived || existing.status === 'archived') {
      return res.status(400).json({ error: 'Cannot edit an archived scheduling cycle. Restore it first.' });
    }

    const { name, term, termCode, submissionOpenAt, submissionDeadline, status } = req.body;
    const allowedStatuses = ['draft', 'open', 'closed'];
    if (status && !allowedStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Allowed values: ${allowedStatuses.join(', ')}.` });
    }

    const cycle = await SchedulingCycle.findByIdAndUpdate(
      req.params.cycleId,
      {
        ...(name !== undefined && { name: name ? name.trim() : '' }),
        ...(term && { term }),
        ...(termCode && { termCode }),
        ...(submissionOpenAt !== undefined && { submissionOpenAt: submissionOpenAt || null }),
        ...(submissionDeadline !== undefined && { submissionDeadline: submissionDeadline || null }),
        ...(status && { status }),
      },
      { new: true }
    );
    return res.json({ cycle });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/cycles/:cycleId/activate
// Sets this cycle as activeForStudents=true, status='open'.
// Deactivates all other cycles for the same cohort.
// ---------------------------------------------------------------------------
router.post('/cycles/:cycleId/activate', requireAdmin, async (req, res) => {
  try {
    const cycle = await SchedulingCycle.findById(req.params.cycleId);
    if (!cycle) return res.status(404).json({ error: 'Cycle not found.' });
    if (cycle.archived || cycle.status === 'archived') {
      return res.status(400).json({ error: 'Cannot activate an archived cycle. Restore it first.' });
    }

    // Deactivate all other cycles for this cohort
    await SchedulingCycle.updateMany(
      { cohortId: cycle.cohortId, _id: { $ne: cycle._id } },
      { activeForStudents: false }
    );

    cycle.activeForStudents = true;
    cycle.status = 'open';
    await cycle.save();

    return res.json({ cycle });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/cycles/:cycleId/close
// Stops submissions; cycle remains visible to admins with full data.
// ---------------------------------------------------------------------------
router.post('/cycles/:cycleId/close', requireAdmin, async (req, res) => {
  try {
    const cycle = await SchedulingCycle.findByIdAndUpdate(
      req.params.cycleId,
      { status: 'closed', activeForStudents: false },
      { new: true }
    );
    if (!cycle) return res.status(404).json({ error: 'Cycle not found.' });
    return res.json({ cycle });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/cycles/:cycleId/reopen
// Reopens a closed cycle for student submissions.
// Deactivates all other cycles for the same cohort.
// ---------------------------------------------------------------------------
router.post('/cycles/:cycleId/reopen', requireAdmin, async (req, res) => {
  try {
    const cycle = await SchedulingCycle.findById(req.params.cycleId);
    if (!cycle) return res.status(404).json({ error: 'Cycle not found.' });
    if (cycle.archived || cycle.status === 'archived') {
      return res.status(400).json({ error: 'Cannot reopen an archived cycle. Restore it first.' });
    }

    // Deactivate all other cycles for this cohort
    await SchedulingCycle.updateMany(
      { cohortId: cycle.cohortId, _id: { $ne: cycle._id } },
      { activeForStudents: false }
    );

    const updated = await SchedulingCycle.findByIdAndUpdate(
      req.params.cycleId,
      { status: 'open', activeForStudents: true },
      { new: true }
    );
    return res.json({ cycle: updated });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/cycles/:cycleId
// Permanently deletes a scheduling cycle and all data tied to it: student
// submissions, course requests, section preferences, and algorithm runs.
// ---------------------------------------------------------------------------
router.delete('/cycles/:cycleId', requireAdmin, async (req, res) => {
  try {
    const cycle = await SchedulingCycle.findById(req.params.cycleId);
    if (!cycle) return res.status(404).json({ error: 'Cycle not found.' });

    const cycleId = cycle._id;
    const [submissions, requests, prefs, runs] = await Promise.all([
      StudentSubmission.deleteMany({ schedulingCycleId: cycleId }),
      StudentCourseRequest.deleteMany({ schedulingCycleId: cycleId }),
      SectionPreference.deleteMany({ schedulingCycleId: cycleId }),
      AlgorithmRun.deleteMany({ schedulingCycleId: cycleId }),
    ]);
    await SchedulingCycle.deleteOne({ _id: cycleId });

    return res.json({
      deleted: true,
      cycleId: String(cycleId),
      removed: {
        submissions: submissions.deletedCount ?? 0,
        courseRequests: requests.deletedCount ?? 0,
        sectionPreferences: prefs.deletedCount ?? 0,
        algorithmRuns: runs.deletedCount ?? 0,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

