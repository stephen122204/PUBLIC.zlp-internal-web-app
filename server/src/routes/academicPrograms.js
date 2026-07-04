'use strict';
/**
 * server/src/routes/academicPrograms.js
 *
 * GET /api/academic-programs         — list all (with optional ?type=major|minor&q=...&catalog=...)
 * GET /api/academic-programs/majors  — list majors only
 * GET /api/academic-programs/minors  — list minors only
 * GET /api/academic-programs/:id     — get single program
 *
 * Auth: requireAuth (any logged-in user)
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  listAcademicPrograms,
  listMajors,
  listMinors,
  getAcademicProgram,
} = require('../lib/academicPrograms');

const router = express.Router();

// Shared serializer — only expose fields the UI needs
function serializeProgram(p) {
  return {
    id: p.id,
    type: p.type,
    level: p.level ?? 'undergraduate',
    title: p.title,
    college: p.college ?? null,
    department: p.department ?? null,
    catalog: p.catalog ?? null,
    catalogUrl: p.catalogUrl ?? null,
    hasDetailedPlan: p.hasDetailedPlan ?? false,
    degreePlanId: p.degreePlanId ?? null,
  };
}

// ---------------------------------------------------------------------------
// GET /api/academic-programs/majors
// ---------------------------------------------------------------------------
router.get('/majors', requireAuth, (req, res) => {
  try {
    const { q, catalog } = req.query;
    const programs = listMajors({ q, catalog }).map(serializeProgram);
    return res.json({ programs });
  } catch (err) {
    console.error('[academic-programs/majors]', err);
    return res.status(500).json({ error: 'Failed to load majors.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/academic-programs/minors
// ---------------------------------------------------------------------------
router.get('/minors', requireAuth, (req, res) => {
  try {
    const { q, catalog } = req.query;
    const programs = listMinors({ q, catalog }).map(serializeProgram);
    return res.json({ programs });
  } catch (err) {
    console.error('[academic-programs/minors]', err);
    return res.status(500).json({ error: 'Failed to load minors.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/academic-programs/:id  (must be after /majors and /minors)
// ---------------------------------------------------------------------------
router.get('/*id', requireAuth, (req, res) => {
  try {
    const program = getAcademicProgram(req.params.id);
    return res.json({ program: serializeProgram(program) });
  } catch (err) {
    const status = err.statusCode === 404 ? 404 : 500;
    return res.status(status).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/academic-programs   (general list with ?type filter)
// ---------------------------------------------------------------------------
router.get('/', requireAuth, (req, res) => {
  try {
    const { type, q, catalog } = req.query;
    const programs = listAcademicPrograms({ type, q, catalog }).map(serializeProgram);
    return res.json({ programs });
  } catch (err) {
    console.error('[academic-programs]', err);
    return res.status(500).json({ error: 'Failed to load academic programs.' });
  }
});

module.exports = router;
