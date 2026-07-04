const express = require('express');
const crypto = require('crypto');
const CohortInviteLink = require('../../models/CohortInviteLink');
const Cohort = require('../../models/Cohort');
const { requireAdmin } = require('../../middleware/auth');

const router = express.Router();
const SERVER_BASE_URL = process.env.SERVER_BASE_URL || 'http://localhost:3001';
const CLIENT_BASE_URL = process.env.CLIENT_BASE_URL || 'http://localhost:5173';
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// POST /api/admin/cohorts/:id/invite-link  – generate new invite link
router.post('/cohorts/:id/invite-link', requireAdmin, async (req, res) => {
  try {
    const cohort = await Cohort.findById(req.params.id);
    if (!cohort) return res.status(404).json({ error: 'Cohort not found.' });
    if (cohort.archivedAt) return res.status(400).json({ error: 'Cannot create invite links for an archived cohort.' });
    // Revoke any existing active links
    await CohortInviteLink.updateMany(
      { cohortId: req.params.id, status: 'active' },
      { status: 'revoked', revokedAt: new Date() }
    );

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    const invite = await CohortInviteLink.create({
      cohortId: req.params.id,
      tokenHash,
      rawToken,
      status: 'active',
      createdBy: req.user._id,
      expiresAt,
    });

    const inviteUrl = `${CLIENT_BASE_URL}/join/${rawToken}`;

    res.status(201).json({
      inviteUrl,
      expiresAt,
      status: 'active',
      _id: invite._id,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/cohorts/:id/invite-link
router.get('/cohorts/:id/invite-link', requireAdmin, async (req, res) => {
  try {
    const invites = await CohortInviteLink.find({ cohortId: req.params.id })
      .sort({ createdAt: -1 })
      .populate('createdBy', 'name email')
      .lean();

    // Mark any expired active ones; build inviteUrl from stored rawToken
    const now = new Date();
    const result = invites.map((inv) => ({
      ...inv,
      status: inv.status === 'active' && inv.expiresAt < now ? 'expired' : inv.status,
      inviteUrl: inv.rawToken ? `${CLIENT_BASE_URL}/join/${inv.rawToken}` : undefined,
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/invite-links/:id/revoke
router.post('/invite-links/:id/revoke', requireAdmin, async (req, res) => {
  try {
    const invite = await CohortInviteLink.findByIdAndUpdate(
      req.params.id,
      { status: 'revoked', revokedAt: new Date() },
      { new: true }
    );
    if (!invite) return res.status(404).json({ error: 'Not found' });
    res.json(invite);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/cohorts/:id/invite-link/regenerate
router.post('/cohorts/:id/invite-link/regenerate', requireAdmin, async (req, res) => {
  try {
    const cohort = await Cohort.findById(req.params.id);
    if (!cohort) return res.status(404).json({ error: 'Cohort not found.' });
    if (cohort.archivedAt) return res.status(400).json({ error: 'Cannot create invite links for an archived cohort.' });
    // Revoke existing active
    await CohortInviteLink.updateMany(
      { cohortId: req.params.id, status: 'active' },
      { status: 'revoked', revokedAt: new Date() }
    );

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    const invite = await CohortInviteLink.create({
      cohortId: req.params.id,
      tokenHash,
      rawToken,
      status: 'active',
      createdBy: req.user._id,
      expiresAt,
    });

    const inviteUrl = `${CLIENT_BASE_URL}/join/${rawToken}`;

    res.status(201).json({
      inviteUrl,
      expiresAt,
      status: 'active',
      _id: invite._id,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
