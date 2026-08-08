'use strict';
const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const { searchCourses, buildCourseHistory, listSubjects, listCoursesBySubject } = require('../../lib/courseSearch');
const { getCourseSections } = require('../../lib/courseSections');
const { getCourseGradeStats } = require('../../lib/gradeDistributions');
const { attachSyllabusLinks } = require('../../lib/syllabusResolver');
const { getCourseCatalogTitle, getCoursePrereqsBatch } = require('../../lib/courseCatalogTitles');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/student/courses/subjects?campus=college-station
// Returns sorted list of all unique subject codes
// ---------------------------------------------------------------------------
router.get('/subjects', requireAuth, (req, res) => {
  const campus = String(req.query.campus ?? 'college-station').trim();
  try {
    return res.json({ subjects: listSubjects({ campus }) });
  } catch (err) {
    console.error('[courses/subjects]', err);
    return res.status(500).json({ error: 'Failed to list subjects.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/student/courses/by-subject?subject=MEEN&campus=college-station
// Returns all courses for a subject with their titles
// ---------------------------------------------------------------------------
router.get('/by-subject', requireAuth, (req, res) => {
  const subject = String(req.query.subject ?? '').trim().toUpperCase();
  const campus = String(req.query.campus ?? 'college-station').trim();
  if (!subject) return res.status(400).json({ error: 'Missing required query parameter: subject' });
  try {
    return res.json({ subject, courses: listCoursesBySubject(subject, { campus }) });
  } catch (err) {
    console.error('[courses/by-subject]', err);
    return res.status(500).json({ error: 'Failed to list courses by subject.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/student/courses/search?q=...&campus=college-station
// ---------------------------------------------------------------------------
router.get('/search', requireAuth, (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const campus = String(req.query.campus ?? 'college-station').trim();

  if (!q) {
    return res.status(400).json({ error: 'Missing required query parameter: q' });
  }

  try {
    const results = searchCourses(q, { campus });
    return res.json({ query: q, campus, count: results.length, results });
  } catch (err) {
    console.error('[courses/search]', err);
    return res.status(500).json({ error: 'Course search failed.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/student/courses/catalog-title?code=AERO+430
// Proper Title Case course title from the official TAMU catalog pages — the same
// source used to build degree-flowchart node titles (unlike /search, which returns
// ALL-CAPS abbreviated titles from Howdy's Banner index).
// ---------------------------------------------------------------------------
router.get('/catalog-title', requireAuth, async (req, res) => {
  const code = String(req.query.code ?? '').trim();
  if (!code) return res.status(400).json({ error: 'Missing required query parameter: code' });
  try {
    const title = await getCourseCatalogTitle(code);
    return res.json({ code, title });
  } catch (err) {
    console.error('[courses/catalog-title]', err);
    return res.status(500).json({ error: 'Failed to look up course title.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/student/courses/prereqs?codes=CSCE+221,MATH+151
// Batch prereq/coreq lookup from the official catalog pages. Used by the degree
// flowchart's "My Plan" mode to draw all prerequisite arrows between the courses
// the student placed in their plan. Read-only; does not affect classification.
// ---------------------------------------------------------------------------
router.get('/prereqs', requireAuth, async (req, res) => {
  const codes = String(req.query.codes ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  if (!codes.length) return res.status(400).json({ error: 'Missing required query parameter: codes' });
  try {
    const prereqs = await getCoursePrereqsBatch(codes.slice(0, 150));
    return res.json({ prereqs });
  } catch (err) {
    console.error('[courses/prereqs]', err);
    return res.status(500).json({ error: 'Failed to look up prerequisites.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/student/courses/history?subject=CSCE&course=121&campus=college-station
// ---------------------------------------------------------------------------
router.get('/history', requireAuth, (req, res) => {
  const subject = String(req.query.subject ?? '').trim();
  const course = String(req.query.course ?? '').trim();
  const campus = String(req.query.campus ?? 'college-station').trim();

  if (!subject || !course) {
    return res
      .status(400)
      .json({ error: 'Missing required query parameters: subject, course' });
  }

  try {
    const history = buildCourseHistory(subject, course, { campus });
    if (!history) {
      return res
        .status(404)
        .json({ error: `No offering history found for ${subject} ${course}.` });
    }
    return res.json(history);
  } catch (err) {
    console.error('[courses/history]', err);
    return res.status(500).json({ error: 'Course history lookup failed.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/student/courses/sections?subject=CSCE&course=121&term=202531
// ---------------------------------------------------------------------------
router.get('/sections', requireAuth, async (req, res) => {
  const subject = String(req.query.subject ?? '').trim().toUpperCase();
  const course = String(req.query.course ?? '').trim().toUpperCase();
  const term = String(req.query.term ?? '').trim();

  if (!subject || !course || !term) {
    return res
      .status(400)
      .json({ error: 'Missing required query parameters: subject, course, term' });
  }

  try {
    const sections = await getCourseSections(subject, course, term);
    // Attach historical GPA stats for the instructors teaching this course.
    const instructorNames = [...new Set(sections.flatMap((s) => s.instructors ?? []))];
    const gradeStats = getCourseGradeStats(subject, course, instructorNames);
    // Best-effort: attach each instructor's syllabus PDF link (viewed term, last-taught term, or older).
    await attachSyllabusLinks(subject, course, term, sections, gradeStats);
    return res.json({ subject, courseNumber: course, termCode: term, count: sections.length, sections, gradeStats });
  } catch (err) {
    console.error('[courses/sections]', err);
    const status = err.statusCode && err.statusCode < 600 ? err.statusCode : 502;
    return res.status(status).json({ error: `Failed to fetch sections from Howdy: ${err.message}` });
  }
});

module.exports = router;
