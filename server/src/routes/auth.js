const express = require('express');
const passport = require('passport');
const crypto = require('crypto');
// CohortInviteLink kept for backward-compat validate-invite route below
const CohortInviteLink = require('../models/CohortInviteLink');

const router = express.Router();

const CLIENT_BASE_URL = process.env.CLIENT_BASE_URL || 'http://localhost:5173';

// GET /api/auth/google
router.get('/google', (req, res, next) => {
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

// GET /api/auth/google/callback
router.get(
  '/google/callback',
  (req, res, next) => {
    passport.authenticate('google', { session: true }, (err, user, info) => {
      if (err) {
        console.error('Auth error:', err);
        return res.redirect(`${CLIENT_BASE_URL}/access-denied?reason=error`);
      }
      if (!user) {
        const reason = info?.message || 'denied';
        return res.redirect(`${CLIENT_BASE_URL}/access-denied?reason=${encodeURIComponent(reason)}`);
      }

      req.logIn(user, (loginErr) => {
        if (loginErr) {
          return res.redirect(`${CLIENT_BASE_URL}/access-denied?reason=error`);
        }
        if (user.role === 'admin' || user.role === 'developer') {
          return res.redirect(`${CLIENT_BASE_URL}/admin/cohorts`);
        }
        // Students without a cohort are sent to the join-cohort page
        if (!user.cohortId) {
          return res.redirect(`${CLIENT_BASE_URL}/join-cohort`);
        }
        return res.redirect(`${CLIENT_BASE_URL}/student/dashboard`);
      });
    })(req, res, next);
  }
);

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const { _id, email, name, role, cohortId } = req.user;
  const isDeveloper = role === 'developer';
  res.json({ _id, email, name, role, cohortId, isDeveloper, devSwitchEnabled: isDeveloper });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.logout((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.json({ message: 'Logged out' });
    });
  });
});

// GET /api/auth/validate-invite/:token  (public – used by Join page)
router.get('/validate-invite/:token', async (req, res) => {
  try {
    const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
    const invite = await CohortInviteLink.findOne({ tokenHash }).populate('cohortId');
    if (!invite) return res.status(404).json({ valid: false, reason: 'not_found' });
    if (invite.status === 'revoked') return res.status(410).json({ valid: false, reason: 'revoked' });
    if (invite.status === 'expired' || invite.expiresAt < new Date()) {
      if (invite.status === 'active') {
        invite.status = 'expired';
        await invite.save();
      }
      return res.status(410).json({ valid: false, reason: 'expired' });
    }
    res.json({ valid: true, cohort: { name: invite.cohortId.name, term: invite.cohortId.term } });
  } catch (err) {
    res.status(500).json({ valid: false, reason: 'error' });
  }
});

module.exports = router;
