const express = require('express');
const Cohort = require('../../models/Cohort');
const CohortMember = require('../../models/CohortMember');
const CohortInviteLink = require('../../models/CohortInviteLink');
const StudentSubmission = require('../../models/StudentSubmission');
const SchedulingCycle = require('../../models/SchedulingCycle');
const { requireAdmin } = require('../../middleware/auth');

// Count submitted submissions for a cohort's MOST RECENT (by term) non-archived cycle only.
// Earlier closed-but-unarchived semesters are not added in — the box reflects just the latest
// semester in the schedule (e.g. show Spring 2026's count even while Fall 2025 is closed but
// not yet archived). termCode is a numeric string (e.g. "202611" Spring 2026 > "202531" Fall
// 2025), so the highest value is the most recent term.
async function countActiveSubmitted(cohortId) {
  const cycles = await SchedulingCycle.find({
    cohortId,
    archived:     { $ne: true },
    status:       { $ne: 'archived' },
    isSystemDemo: { $ne: true },
  }).select('_id termCode createdAt');

  if (cycles.length === 0) {
    // Legacy cohorts with no scheduling cycles — count submissions not tied to any cycle.
    return StudentSubmission.countDocuments({
      cohortId,
      status: 'submitted',
      schedulingCycleId: { $exists: false },
    });
  }

  // Pick the latest term (highest numeric termCode; tie-break on most recently created).
  const latest = cycles.reduce((best, c) => {
    const t = Number(c.termCode) || 0;
    const bt = Number(best.termCode) || 0;
    if (t !== bt) return t > bt ? c : best;
    return c.createdAt > best.createdAt ? c : best;
  });

  return StudentSubmission.countDocuments({
    cohortId,
    status: 'submitted',
    schedulingCycleId: latest._id,
  });
}

const router = express.Router();

// GET /api/admin/cohorts
// By default hides archived cohorts. Pass ?includeArchived=true to include them.
router.get('/cohorts', requireAdmin, async (req, res) => {
  try {
    const includeArchived = req.query.includeArchived === 'true';
    // Always hide system demo cohorts from admin cohort lists.
    const filter = { isSystemDemo: { $ne: true } };
    if (!includeArchived) filter.archivedAt = { $exists: false };
    // Manual order first (sortIndex 1..N), then unordered (sortIndex 0) newest-first.
    const cohorts = await Cohort.find(filter).sort({ sortIndex: 1, createdAt: -1 });
    // Enrich with member counts and invite status
    const enriched = await Promise.all(
      cohorts.map(async (c) => {
        const joinedCount = await CohortMember.countDocuments({ cohortId: c._id, status: 'active' });
        const submittedCount = await countActiveSubmitted(c._id);
        const invite = await CohortInviteLink.findOne({ cohortId: c._id, status: 'active' }).sort({ createdAt: -1 });
        return {
          ...c.toObject(),
          joinedCount,
          submittedCount,
          inviteStatus: invite
            ? invite.expiresAt < new Date()
              ? 'expired'
              : 'active'
            : 'none',
        };
      })
    );
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/cohorts
router.post('/cohorts', requireAdmin, async (req, res) => {
  try {
    const { name, notes, catalogYear } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const cohort = await Cohort.create({
      name,
      ...(notes && { notes }),
      ...(catalogYear && { catalogYear }),
      createdBy: req.user._id,
    });
    res.status(201).json(cohort);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/cohorts/reorder
// Body: { orderedIds: [cohortId, ...] } — persists the admin's manual cohort order.
// Assigns sortIndex 1..N in the given order. Must be declared before /cohorts/:id.
router.patch('/cohorts/reorder', requireAdmin, async (req, res) => {
  try {
    const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds : null;
    if (!orderedIds || orderedIds.length === 0) {
      return res.status(400).json({ error: 'orderedIds (non-empty array) is required.' });
    }
    const ops = orderedIds.map((id, index) => ({
      updateOne: { filter: { _id: id }, update: { $set: { sortIndex: index + 1 } } },
    }));
    await Cohort.bulkWrite(ops);
    return res.json({ reordered: orderedIds.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/cohorts/:id
router.get('/cohorts/:id', requireAdmin, async (req, res) => {
  try {
    const cohort = await Cohort.findById(req.params.id);
    if (!cohort) return res.status(404).json({ error: 'Not found' });
    const joinedCount = await CohortMember.countDocuments({ cohortId: cohort._id, status: 'active' });
    const submittedCount = await countActiveSubmitted(cohort._id);
    const invite = await CohortInviteLink.findOne({ cohortId: cohort._id, status: 'active' }).sort({ createdAt: -1 });
    res.json({
      ...cohort.toObject(),
      joinedCount,
      submittedCount,
      inviteStatus: invite
        ? invite.expiresAt < new Date()
          ? 'expired'
          : 'active'
        : 'none',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/cohorts/:id
router.patch('/cohorts/:id', requireAdmin, async (req, res) => {
  try {
    const { name, active, notes, catalogYear } = req.body;
    const existing = await Cohort.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.archivedAt) return res.status(400).json({ error: 'Cannot edit an archived cohort.' });
    const cohort = await Cohort.findByIdAndUpdate(
      req.params.id,
      {
        ...(name && { name }),
        ...(active !== undefined && { active }),
        ...(notes !== undefined && { notes: notes || '' }),
        ...(catalogYear !== undefined && { catalogYear: catalogYear || null }),
      },
      { new: true }
    );
    if (!cohort) return res.status(404).json({ error: 'Not found' });
    res.json(cohort);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/cohorts/:id/archive
// Soft-archives a cohort. Sets active=false, archivedAt, archivedBy.
// Does NOT delete any associated data.
router.post('/cohorts/:id/archive', requireAdmin, async (req, res) => {
  try {
    const cohort = await Cohort.findById(req.params.id);
    if (!cohort) return res.status(404).json({ error: 'Not found' });
    if (cohort.archivedAt) return res.status(400).json({ error: 'Cohort is already archived.' });
    cohort.active = false;
    cohort.archivedAt = new Date();
    cohort.archivedBy = req.user._id;
    await cohort.save();
    res.json(cohort);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/cohorts/:id/unarchive
router.post('/cohorts/:id/unarchive', requireAdmin, async (req, res) => {
  try {
    const cohort = await Cohort.findById(req.params.id);
    if (!cohort) return res.status(404).json({ error: 'Not found' });
    if (!cohort.archivedAt) return res.status(400).json({ error: 'Cohort is not archived.' });
    cohort.active = true;
    cohort.archivedAt = undefined;
    cohort.archivedBy = undefined;
    await cohort.save();
    res.json(cohort);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
