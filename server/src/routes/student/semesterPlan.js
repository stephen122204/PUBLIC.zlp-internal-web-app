'use strict';
/**
 * Student semester plan routes.
 *
 * GET  /api/student/degree-plan/term-options
 * GET  /api/student/degree-plan/semesters
 * PUT  /api/student/degree-plan/semesters
 * POST /api/student/degree-plan/import-text
 * POST /api/student/degree-plan/import-screenshot
 * POST /api/student/degree-plan/confirm-import
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const { requireAuth, resolveStudentContext } = require('../../middleware/auth');
const { getStudentActiveCohort } = require('../../lib/submissionHelpers');
const StudentSemesterPlan = require('../../models/StudentSemesterPlan');
const StudentPlannedCourse = require('../../models/StudentPlannedCourse');

const router = express.Router();

// ---------------------------------------------------------------------------
// Term options — shared catalog data (student-accessible, no admin required)
// ---------------------------------------------------------------------------
let _termOptionsCache = null;
function loadTermOptions() {
  if (_termOptionsCache) return _termOptionsCache;
  const dataPath = path.join(__dirname, '../../../data/catalog-index.json');
  const parsed = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const rows = Array.isArray(parsed) ? parsed : (parsed.entries || []);

  // Collect all known College Station Fall/Spring/Summer terms from the catalog
  const known = {};
  for (const entry of rows) {
    if (
      entry.campus === 'college-station' &&
      /^(Fall|Spring|Summer)\s/i.test(entry.termDescription) &&
      !known[entry.termCode]
    ) {
      known[entry.termCode] = { termCode: entry.termCode, term: entry.termDescription };
    }
  }

  // Determine year range: earliest catalog year - 5 through latest catalog year + 6
  const catalogYears = Object.keys(known).map((tc) => parseInt(tc.substring(0, 4), 10)).filter(Boolean);
  const fallback = new Date().getFullYear();
  const earliestCatalogYear = catalogYears.length ? Math.min(...catalogYears) : fallback;
  const latestCatalogYear   = catalogYears.length ? Math.max(...catalogYears) : fallback;
  const minYear = earliestCatalogYear - 5;
  const maxYear = latestCatalogYear + 6;

  // TAMU term code convention: YYYY11 = Spring, YYYY21 = Summer, YYYY31 = Fall
  const SEASON_CODES = { Fall: '31', Summer: '21', Spring: '11' };
  // Emit newest-first: within each year Fall > Summer > Spring
  const result = [];
  for (let y = maxYear; y >= minYear; y--) {
    for (const season of ['Fall', 'Summer', 'Spring']) {
      const termCode = `${y}${SEASON_CODES[season]}`;
      result.push(
        known[termCode] ?? { termCode, term: `${season} ${y} - College Station` }
      );
    }
  }

  _termOptionsCache = result;
  return _termOptionsCache;
}

// GET /api/student/degree-plan/term-options
router.get('/term-options', requireAuth, (_req, res) => {
  try {
    return res.json({ terms: loadTermOptions() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a course code to "SUBJ NUM" form */
function normCode(s) {
  const m = String(s ?? '').toUpperCase().trim().match(/\b([A-Z]{3,5})\s*(\d{3}[A-Z]?)\b/u);
  return m ? `${m[1]} ${m[2]}` : null;
}

/** Build the response shape for semesters + courses */
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
    notes:            c.notes ?? '',
  };
}

// ---------------------------------------------------------------------------
// GET /api/student/degree-plan/semesters
// ---------------------------------------------------------------------------
router.get('/semesters', resolveStudentContext, async (req, res) => {
  try {
    const cohort = await getStudentActiveCohort(req.studentUser._id);
    if (!cohort) return res.json({ semesters: [] });

    const semesters = await StudentSemesterPlan.find(
      { userId: req.studentUser._id, cohortId: cohort._id },
      null,
      { sort: { orderIndex: 1 } }
    ).lean();

    if (semesters.length === 0) return res.json({ semesters: [] });

    const semIds = semesters.map((s) => s._id);
    const courses = await StudentPlannedCourse.find(
      { semesterPlanId: { $in: semIds } }
    ).lean();

    const byId = {};
    for (const c of courses) {
      const key = c.semesterPlanId.toString();
      if (!byId[key]) byId[key] = [];
      byId[key].push(c);
    }

    return res.json({ semesters: shapeSemesterList(semesters, byId) });
  } catch (err) {
    console.error('[degree-plan GET semesters]', err);
    return res.status(500).json({ error: 'Failed to load semester plan.' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/student/degree-plan/semesters
// Full replace of the student's plan.
// ---------------------------------------------------------------------------
router.put('/semesters', resolveStudentContext, async (req, res) => {
  try {
    const cohort = await getStudentActiveCohort(req.studentUser._id);
    if (!cohort) return res.status(400).json({ error: 'Not enrolled in an active cohort.' });

    const { semesters: incomingSemesters } = req.body;
    if (!Array.isArray(incomingSemesters)) {
      return res.status(400).json({ error: 'semesters must be an array.' });
    }

    const userId   = req.studentUser._id;
    const cohortId = cohort._id;

    // Use a session for atomicity
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // Delete existing semesters + courses
        const existing = await StudentSemesterPlan.find({ userId, cohortId }, '_id', { session });
        const existingIds = existing.map((s) => s._id);
        if (existingIds.length > 0) {
          await StudentPlannedCourse.deleteMany({ semesterPlanId: { $in: existingIds } }, { session });
          await StudentSemesterPlan.deleteMany({ userId, cohortId }, { session });
        }

        // Insert new semesters and courses
        for (let i = 0; i < incomingSemesters.length; i++) {
          const s = incomingSemesters[i];
          const label = String(s.label ?? `Semester ${i + 1}`).slice(0, 100);
          const status = ['completed', 'in_progress', 'planned'].includes(s.status) ? s.status : 'planned';
          const term   = ['Fall', 'Spring', 'Summer', 'Other'].includes(s.term) ? s.term : 'Other';

          const [newSem] = await StudentSemesterPlan.create([{
            userId, cohortId,
            label,
            year:       s.year ?? null,
            term,
            termCode:   s.termCode ? String(s.termCode).slice(0, 20) : null,
            orderIndex: typeof s.orderIndex === 'number' ? s.orderIndex : i,
            status,
            notes:      s.notes ? String(s.notes).slice(0, 500) : '',
          }], { session });

          // Insert courses for this semester
          const courses = Array.isArray(s.courses) ? s.courses : [];
          for (const c of courses) {
            const code = normCode(c.code ?? `${c.subject} ${c.number}`);
            if (!code) continue;
            const [subj, num] = code.split(' ');
            const courseStatus = ['completed', 'in_progress', 'planned'].includes(c.status)
              ? c.status
              : status;
            await StudentPlannedCourse.create([{
              userId, cohortId,
              semesterPlanId: newSem._id,
              subject:    subj,
              number:     num,
              code,
              title:       c.title ? String(c.title).slice(0, 200) : '',
              creditHours: c.creditHours != null ? Number(c.creditHours) : null,
              status:      courseStatus,
              transfer:    !!c.transfer,
              honors:      !!c.honors,
              writingRequirement: c.writingRequirement ? String(c.writingRequirement).slice(0, 100) : '',
              source:      ['manual','screenshot_import','transcript_import','admin_edit','developer_edit'].includes(c.source) ? c.source : 'manual',
              notes:       c.notes ? String(c.notes).slice(0, 500) : '',
            }], { session });
          }
        }
      });
    } finally {
      session.endSession();
    }

    // Return saved plan
    return router.handle({ method: 'GET', url: '/semesters', user: req.studentUser }, res, () => {});
  } catch (err) {
    console.error('[degree-plan PUT semesters]', err);
    return res.status(500).json({ error: 'Failed to save semester plan.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/student/degree-plan/import-text
// Parse a pasted text blob into a draft semester plan (not saved yet).
// ---------------------------------------------------------------------------
router.post('/import-text', requireAuth, (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required.' });
    }
    const result = parseTextImport(text);
    return res.json(result);
  } catch (err) {
    console.error('[degree-plan import-text]', err);
    return res.status(500).json({ error: 'Failed to parse text.' });
  }
});

/**
 * Parse plain-text degree plan.
 * Supports formats like:
 *   2026 Fall
 *   CSCE 442 SCIENTIFIC PROGRAMMING 3
 *   STAT 335 PRINCIPLES OF DATA SCIENCE 3
 */
function parseTextImport(raw) {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const semesters = [];
  let current = null;
  let orderIndex = 0;

  const semHeadingRe = /^(20\d\d)\s+(Fall|Spring|Summer|Winter)/i;
  const altHeadingRe = /^(Fall|Spring|Summer|Winter)\s+(20\d\d)/i;
  const courseRe = /\b([A-Z]{3,5})\s+(\d{3}[A-Z]?)\b/;

  for (const line of lines) {
    const semMatch = semHeadingRe.exec(line) || altHeadingRe.exec(line);
    if (semMatch) {
      // Determine year and term
      let year, term;
      if (semHeadingRe.test(line)) {
        const m = semHeadingRe.exec(line);
        year = parseInt(m[1], 10);
        term = m[2];
      } else {
        const m = altHeadingRe.exec(line);
        year = parseInt(m[2], 10);
        term = m[1];
      }
      const label = `${year} ${term.charAt(0).toUpperCase() + term.slice(1).toLowerCase()}`;
      // Infer status from year/term
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth(); // 0-indexed
      let status = 'planned';
      if (year < currentYear) status = 'completed';
      else if (year === currentYear) {
        if (term.toLowerCase() === 'spring' && currentMonth >= 1 && currentMonth <= 4) status = 'in_progress';
        else if (term.toLowerCase() === 'summer' && currentMonth >= 5 && currentMonth <= 7) status = 'in_progress';
        else if (term.toLowerCase() === 'fall' && currentMonth >= 8 && currentMonth <= 11) status = 'in_progress';
        else if (year < currentYear) status = 'completed';
      }
      current = { label, year, term: term.charAt(0).toUpperCase() + term.slice(1).toLowerCase(), status, orderIndex, courses: [] };
      semesters.push(current);
      orderIndex++;
      continue;
    }

    // Try to parse a course line
    const courseMatch = courseRe.exec(line);
    if (!courseMatch || !current) continue;

    const subject = courseMatch[1];
    const number  = courseMatch[2];
    const code    = `${subject} ${number}`;

    // Extract credit hours — last standalone number on the line
    const parts = line.split(/\s+/);
    let creditHours = null;
    for (let i = parts.length - 1; i >= 0; i--) {
      const n = parseFloat(parts[i]);
      if (!isNaN(n) && n >= 0 && n <= 20) {
        creditHours = n;
        break;
      }
    }

    // Title = everything between code and trailing number
    const afterCode = line.slice(line.indexOf(number) + number.length).trim();
    const titleMatch = afterCode.match(/^([A-Z\s\-\/,.'()&]+?)(?:\s+\d+(?:\.\d+)?\s*$|\s*$)/i);
    const title = titleMatch ? titleMatch[1].trim() : '';

    const courseStatus = current.status === 'in_progress' ? 'in_progress'
      : current.status === 'completed' ? 'completed'
      : 'planned';

    current.courses.push({ subject, number, code, title, creditHours, status: courseStatus, source: 'transcript_import', confidence: 0.7 });
  }

  const warnings = ['Review all imported courses before saving. Titles and credit hours may be approximate.'];
  if (semesters.length === 0) warnings.push('No semester headings found. Start lines with a year and term, e.g. "2026 Fall".');

  return { semesters, warnings, confidence: 0.7 };
}

// ---------------------------------------------------------------------------
// POST /api/student/degree-plan/import-screenshot
// OCR screenshot import stub.
// ---------------------------------------------------------------------------
router.post('/import-screenshot', requireAuth, (_req, res) => {
  return res.json({
    semesters: [],
    warnings: [
      'Screenshot OCR is not yet implemented. Please use the text import option or enter your plan manually.',
      'You can paste text from your Howdy degree planner into the text import box.',
    ],
    confidence: 0,
    status: 'ocr_pending',
  });
});

// ---------------------------------------------------------------------------
// POST /api/student/degree-plan/confirm-import
// Save a confirmed import (same shape as PUT /semesters but merges).
// Delegates to the PUT handler logic inline.
// ---------------------------------------------------------------------------
router.post('/confirm-import', resolveStudentContext, async (req, res) => {
  try {
    const cohort = await getStudentActiveCohort(req.studentUser._id);
    if (!cohort) return res.status(400).json({ error: 'Not enrolled in an active cohort.' });

    const { semesters: incomingSemesters, mergeMode = 'replace' } = req.body;
    if (!Array.isArray(incomingSemesters)) {
      return res.status(400).json({ error: 'semesters must be an array.' });
    }

    const userId   = req.studentUser._id;
    const cohortId = cohort._id;

    if (mergeMode === 'replace') {
      // Same as PUT /semesters — full replace
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const existing = await StudentSemesterPlan.find({ userId, cohortId }, '_id', { session });
          const existingIds = existing.map((s) => s._id);
          if (existingIds.length > 0) {
            await StudentPlannedCourse.deleteMany({ semesterPlanId: { $in: existingIds } }, { session });
            await StudentSemesterPlan.deleteMany({ userId, cohortId }, { session });
          }
          for (let i = 0; i < incomingSemesters.length; i++) {
            const s = incomingSemesters[i];
            const label = String(s.label ?? `Semester ${i + 1}`).slice(0, 100);
            const status = ['completed', 'in_progress', 'planned'].includes(s.status) ? s.status : 'planned';
            const term   = ['Fall', 'Spring', 'Summer', 'Other'].includes(s.term) ? s.term : 'Other';
            const [newSem] = await StudentSemesterPlan.create([{
              userId, cohortId, label,
              year: s.year ?? null, term,
              termCode: s.termCode ? String(s.termCode).slice(0, 20) : null,
              orderIndex: typeof s.orderIndex === 'number' ? s.orderIndex : i,
              status, notes: s.notes ? String(s.notes).slice(0, 500) : '',
            }], { session });
            for (const c of (s.courses ?? [])) {
              const code = normCode(c.code ?? `${c.subject} ${c.number}`);
              if (!code) continue;
              const [subj, num] = code.split(' ');
              await StudentPlannedCourse.create([{
                userId, cohortId, semesterPlanId: newSem._id,
                subject: subj, number: num, code,
                title: c.title ? String(c.title).slice(0, 200) : '',
                creditHours: c.creditHours != null ? Number(c.creditHours) : null,
                status: ['completed','in_progress','planned'].includes(c.status) ? c.status : status,
                transfer: !!c.transfer, honors: !!c.honors,
                writingRequirement: c.writingRequirement ? String(c.writingRequirement).slice(0, 100) : '',
                source: ['manual','screenshot_import','transcript_import','admin_edit','developer_edit'].includes(c.source) ? c.source : 'transcript_import',
                notes: c.notes ? String(c.notes).slice(0, 500) : '',
              }], { session });
            }
          }
        });
      } finally {
        session.endSession();
      }
    }

    // Reload and return
    const semesters = await StudentSemesterPlan.find(
      { userId, cohortId }, null, { sort: { orderIndex: 1 } }
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
    console.error('[degree-plan confirm-import]', err);
    return res.status(500).json({ error: 'Failed to save imported plan.' });
  }
});

module.exports = router;
