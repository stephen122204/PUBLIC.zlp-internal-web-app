'use strict';

const express = require('express');
const Cohort = require('../../models/Cohort');
const { requireAdmin } = require('../../middleware/auth');
const {
  normalizeJoinCode,
  validateJoinCodeFormat,
  generateUniqueJoinCode,
} = require('../../lib/joinCode');

const router = express.Router();

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

// Auto-disable expired codes; returns updated doc if changed.
async function autoExpireIfNeeded(cohort) {
  if (cohort.joinCodeEnabled && cohort.joinCodeExpiresAt && new Date() > cohort.joinCodeExpiresAt) {
    cohort.joinCodeEnabled = false;
    cohort.joinCodeExpiresAt = null;
    await cohort.save();
  }
  return cohort;
}

// GET /api/admin/cohorts/:cohortId/join-code
router.get('/cohorts/:cohortId/join-code', requireAdmin, async (req, res) => {
  try {
    const cohort = await Cohort.findById(req.params.cohortId);
    if (!cohort) return res.status(404).json({ error: 'Cohort not found.' });
    await autoExpireIfNeeded(cohort);
    res.json({
      cohortId:          cohort._id,
      cohortName:        cohort.name,
      joinCode:          cohort.joinCode ?? null,
      joinCodeEnabled:   cohort.joinCodeEnabled,
      joinCodeExpiresAt: cohort.joinCodeExpiresAt ?? null,
      joinCodeUpdatedAt: cohort.joinCodeUpdatedAt ?? null,
      archived:          !!cohort.archivedAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/cohorts/:cohortId/join-code/generate
router.post('/cohorts/:cohortId/join-code/generate', requireAdmin, async (req, res) => {
  try {
    const cohort = await Cohort.findById(req.params.cohortId);
    if (!cohort) return res.status(404).json({ error: 'Cohort not found.' });
    if (cohort.archivedAt) {
      return res.status(400).json({ error: 'Archived cohorts cannot have join codes.' });
    }
    const code = await generateUniqueJoinCode();
    const now = new Date();
    cohort.joinCode          = code;
    cohort.joinCodeEnabled   = true;
    cohort.joinCodeExpiresAt = new Date(now.getTime() + THREE_DAYS_MS);
    cohort.joinCodeUpdatedAt = now;
    cohort.joinCodeUpdatedBy = req.user._id;
    await cohort.save();
    res.status(201).json({
      cohortId:          cohort._id,
      cohortName:        cohort.name,
      joinCode:          code,
      joinCodeEnabled:   true,
      joinCodeExpiresAt: cohort.joinCodeExpiresAt,
      joinCodeUpdatedAt: cohort.joinCodeUpdatedAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/cohorts/:cohortId/join-code/regenerate
router.post('/cohorts/:cohortId/join-code/regenerate', requireAdmin, async (req, res) => {
  try {
    const cohort = await Cohort.findById(req.params.cohortId);
    if (!cohort) return res.status(404).json({ error: 'Cohort not found.' });
    if (cohort.archivedAt) {
      return res.status(400).json({ error: 'Archived cohorts cannot have join codes.' });
    }
    const code = await generateUniqueJoinCode();
    const now = new Date();
    cohort.joinCode          = code;
    cohort.joinCodeEnabled   = true;
    cohort.joinCodeExpiresAt = new Date(now.getTime() + THREE_DAYS_MS);
    cohort.joinCodeUpdatedAt = now;
    cohort.joinCodeUpdatedBy = req.user._id;
    await cohort.save();
    res.json({
      cohortId:          cohort._id,
      cohortName:        cohort.name,
      joinCode:          code,
      joinCodeEnabled:   true,
      joinCodeExpiresAt: cohort.joinCodeExpiresAt,
      joinCodeUpdatedAt: cohort.joinCodeUpdatedAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/cohorts/:cohortId/join-code  — set custom code
router.put('/cohorts/:cohortId/join-code', requireAdmin, async (req, res) => {
  try {
    const cohort = await Cohort.findById(req.params.cohortId);
    if (!cohort) return res.status(404).json({ error: 'Cohort not found.' });
    if (cohort.archivedAt) {
      return res.status(400).json({ error: 'Archived cohorts cannot have join codes.' });
    }
    const raw = req.body.code;
    if (!raw) return res.status(400).json({ error: 'code is required.' });
    const code = normalizeJoinCode(raw);
    if (!validateJoinCodeFormat(code)) {
      return res.status(400).json({ error: 'Join code must be exactly 6 letters or numbers.' });
    }
    // Check uniqueness (exclude this cohort)
    const conflict = await Cohort.findOne({ joinCode: code, _id: { $ne: cohort._id } }).lean();
    if (conflict) {
      return res.status(409).json({ error: 'That join code is already in use by another cohort.' });
    }
    const now = new Date();
    cohort.joinCode          = code;
    cohort.joinCodeEnabled   = true;
    cohort.joinCodeExpiresAt = new Date(now.getTime() + THREE_DAYS_MS);
    cohort.joinCodeUpdatedAt = now;
    cohort.joinCodeUpdatedBy = req.user._id;
    await cohort.save();
    res.json({
      cohortId:          cohort._id,
      cohortName:        cohort.name,
      joinCode:          code,
      joinCodeEnabled:   true,
      joinCodeExpiresAt: cohort.joinCodeExpiresAt,
      joinCodeUpdatedAt: cohort.joinCodeUpdatedAt,
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'That join code is already in use by another cohort.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/cohorts/:cohortId/join-code/enabled
router.patch('/cohorts/:cohortId/join-code/enabled', requireAdmin, async (req, res) => {
  try {
    const cohort = await Cohort.findById(req.params.cohortId);
    if (!cohort) return res.status(404).json({ error: 'Cohort not found.' });
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean.' });
    }
    const now = new Date();
    cohort.joinCodeEnabled   = enabled;
    cohort.joinCodeExpiresAt = enabled ? new Date(now.getTime() + THREE_DAYS_MS) : null;
    cohort.joinCodeUpdatedAt = now;
    cohort.joinCodeUpdatedBy = req.user._id;
    await cohort.save();
    res.json({
      cohortId:          cohort._id,
      joinCode:          cohort.joinCode ?? null,
      joinCodeEnabled:   cohort.joinCodeEnabled,
      joinCodeExpiresAt: cohort.joinCodeExpiresAt ?? null,
      joinCodeUpdatedAt: cohort.joinCodeUpdatedAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
