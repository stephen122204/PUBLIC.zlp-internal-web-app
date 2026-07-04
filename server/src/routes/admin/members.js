const express = require('express');
const CohortMember = require('../../models/CohortMember');
const User = require('../../models/User');
const { requireAdmin } = require('../../middleware/auth');

const router = express.Router();

// GET /api/admin/cohorts/:id/members
router.get('/cohorts/:id/members', requireAdmin, async (req, res) => {
  try {
    const { includeRemoved } = req.query;
    const filter = { cohortId: req.params.id };
    if (!includeRemoved) filter.status = 'active';

    const members = await CohortMember.find(filter)
      .populate('userId', 'name email cohortId lastLoginAt createdAt isDummy dummyCreatedAt isDemoStudent demoForAdmin')
      .sort({ joinedAt: -1 })
      .lean();

    res.json(members.filter((m) => !m.userId?.isDemoStudent));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/cohorts/:cohortId/members/:userId/remove
router.post('/cohorts/:cohortId/members/:userId/remove', requireAdmin, async (req, res) => {
  try {
    const membership = await CohortMember.findOneAndUpdate(
      { cohortId: req.params.cohortId, userId: req.params.userId, status: 'active' },
      { status: 'removed', removedAt: new Date() },
      { new: true }
    );
    if (!membership) return res.status(404).json({ error: 'Active membership not found' });

    // Clear cohortId on user
    await User.findByIdAndUpdate(req.params.userId, { cohortId: null });

    res.json(membership);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
