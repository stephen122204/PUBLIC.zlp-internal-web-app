'use strict';
/**
 * Howdy Degree Plan JSON import — student route.
 *
 * POST /api/student/howdy-import
 *
 * Accepts a "degreePlanCourses" JSON payload that the student copies from
 * the Howdy portal (network tab or page source).  Parses it into our
 * StudentSemesterPlan / StudentPlannedCourse schema.
 *
 * Source-of-truth rules (per architecture decision):
 *  - This import is source-of-truth ONLY for the student's personal plan state.
 *  - It is NOT source-of-truth for degree requirements.
 *  - Grades are reduced to pass/fail/in-progress/planned — raw grades are not stored.
 *  - Withdrawn / dropped courses are skipped.
 *  - Existing records with the same label/code are not duplicated.
 */

const express  = require('express');
const mongoose = require('mongoose');
const { resolveStudentContext }          = require('../../middleware/auth');
const { getStudentActiveCohort } = require('../../lib/submissionHelpers');
const StudentSemesterPlan  = require('../../models/StudentSemesterPlan');
const StudentPlannedCourse = require('../../models/StudentPlannedCourse');
const StudentSubmission    = require('../../models/StudentSubmission');

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// TAMU transfer-credit grades — a course is transfer credit iff its grade is one
// of these. Informational only; does not affect classification.
const TRANSFER_GRADES = new Set(['TA', 'TB', 'TC', 'TD', 'TR', 'TCR']);

/**
 * Normalize a course code from Howdy-style subject + catalogNumber fields.
 * Returns "SUBJ NNN" or null.
 */
function normCode(subject, number) {
  const s = String(subject  ?? '').trim().toUpperCase();
  const n = String(number   ?? '').trim();
  if (!s || !n) return null;
  return `${s} ${n}`;
}

/**
 * Map a Howdy grade string to a simple status.
 * Grade buckets:
 *   withdraw / fail / Q-drop (W, WP, WF, F, U, NC, Q, …) --> SKIP (not completed)
 *   in-progress (IP, RP, I)                              --> in_progress
 *   planned / null / blank                               --> planned
 *   anything else (A, B, C, D, …)                        --> completed (D is a pass)
 * Failed/Q-dropped attempts are skipped entirely; if the course was retaken, only
 * the passing attempt lands in the completed section.
 */
function mapGradeToStatus(gradeRaw) {
  const g = String(gradeRaw ?? '').trim().toUpperCase();
  if (!g || g === 'PLANNED' || g === 'PENDING') return { status: 'planned' };
  if (/^(IP|RP|I|IN PROGRESS)$/.test(g))       return { status: 'in_progress' };
  // Withdrawn, failed, or Q-dropped — the course was not completed, so skip it.
  if (/^(W|WP|WF|WN|WNC|F|U|NC|Q)$/.test(g))    return null;
  // Any other grade (A, B, C, D, …) counts as a completed pass.
  return { status: 'completed' };
}

/**
 * Derive a semester status from Howdy's termCompletionStatus or infer from
 * individual course statuses.
 */
function termStatus(termCode, courses) {
  const allCompleted = courses.every((c) => c.status === 'completed');
  const anyInProg    = courses.some((c)  => c.status === 'in_progress');
  if (allCompleted) return 'completed';
  if (anyInProg)    return 'in_progress';
  return 'planned';
}

/**
 * Parse a term description string like "2023 Fall" or "Fall 2023" or "202331"
 * into { year, term, label }.
 */
function parseTerm(termDescription, termCode) {
  // Try "YYYY Fall/Spring/Summer" or "Fall/Spring/Summer YYYY"
  const m = String(termDescription ?? '').match(/(fall|spring|summer)/i);
  const yMatch = String(termDescription ?? '').match(/\d{4}/);
  const termName = m ? (m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()) : 'Other';
  const year = yMatch ? parseInt(yMatch[0], 10) : null;

  // Fallback: derive from termCode (e.g. "202331" --> 2023 Fall)
  let derivedYear = year;
  let derivedTerm = termName;
  if (termCode && termCode.length >= 5 && (!year || termName === 'Other')) {
    const tcYear = parseInt(String(termCode).slice(0, 4), 10);
    const tcSem  = String(termCode).slice(4, 6);
    derivedYear  = isNaN(tcYear) ? null : tcYear;
    derivedTerm  = tcSem === '11' ? 'Fall' : tcSem === '31' ? 'Spring' : tcSem === '61' ? 'Summer' : 'Other';
  }

  const label = derivedYear
    ? `${derivedYear} ${derivedTerm}`
    : (String(termDescription ?? '').trim() || String(termCode ?? '') || 'Unknown Term');

  return { year: derivedYear, term: derivedTerm, label, termCode: String(termCode ?? '') };
}

/**
 * Accept various degreePlanCourses JSON shapes produced by Howdy:
 *   - Array of course objects (flat list)
 *   - Object with .courses array
 *   - Object with .semesters or .terms array
 *   - Object with .degreePlanCourses array
 *
 * Returns flat array of course objects.
 */
function extractCourses(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.courses))            return body.courses;
  if (body && Array.isArray(body.degreePlanCourses))  return body.degreePlanCourses;
  if (body && Array.isArray(body.semesters)) {
    return body.semesters.flatMap((s) => (s.courses ?? s.plannedCourses ?? []));
  }
  if (body && Array.isArray(body.terms)) {
    return body.terms.flatMap((t) => (t.courses ?? t.plannedCourses ?? []));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

/**
 * POST /api/student/howdy-import
 *
 * Body: { data: <degreePlanCourses JSON> }
 *
 * Returns: { created: { semesters: N, courses: M }, skipped: K, warnings: [] }
 */
router.post('/', resolveStudentContext, async (req, res) => {
  try {
    const userId = req.studentUser._id;

    // Resolve active cohort
    const cohortCtx = await getStudentActiveCohort(userId);
    if (!cohortCtx) {
      return res.status(400).json({ error: 'No active cohort found.' });
    }
    const cohortId = cohortCtx.cohort._id;

    const rawData = req.body?.data;
    if (!rawData) {
      return res.status(400).json({ error: 'Missing "data" field in request body.' });
    }

    const rawCourses = extractCourses(rawData);
    if (rawCourses.length === 0) {
      return res.status(400).json({ error: 'No course records found in the provided JSON. Check the format and try again.' });
    }

    const warnings = [];

    // ── Parse each course record ──────────────────────────────────────────
    const parsedCourses = [];
    for (const c of rawCourses) {
      // Field name normalization — Howdy uses different keys in different endpoints
      const subject      = c.subject       ?? c.subjectCode    ?? c.dept         ?? '';
      const number       = c.catalogNumber ?? c.courseNumber   ?? c.number       ?? '';
      const title        = c.courseTitle   ?? c.title          ?? c.description  ?? '';
      const creditHours  = parseFloat(c.creditHours ?? c.credits ?? c.hours ?? 0) || null;
      const termCode     = String(c.termCode    ?? c.term ?? '').trim();
      const termDesc     = String(c.termDesc    ?? c.termDescription ?? c.semester ?? '').trim();
      const gradeRaw     = c.grade         ?? c.letterGrade ?? c.gradeCode ?? null;

      const code = normCode(subject, number);
      if (!code) {
        warnings.push(`Skipped record with unresolvable course code (subject="${subject}", number="${number}").`);
        continue;
      }

      const gradeResult = mapGradeToStatus(gradeRaw);
      if (!gradeResult) continue;  // withdrawn — silently skip

      parsedCourses.push({
        subject: subject.toUpperCase().trim(),
        number:  String(number).trim(),
        code,
        title:   String(title).trim(),
        creditHours,
        termCode,
        termDesc,
        // Transfer credit — a transfer grade (TA, TB, TC, TR, TCR). Informational only.
        transfer: TRANSFER_GRADES.has(String(gradeRaw ?? '').trim().toUpperCase()),
        ...gradeResult,
      });
    }

    // ── Group by term ─────────────────────────────────────────────────────
    const termMap = new Map(); // termKey --> { termInfo, courses[] }
    for (const pc of parsedCourses) {
      const termKey = pc.termCode || pc.termDesc || 'unknown';
      if (!termMap.has(termKey)) {
        termMap.set(termKey, { termInfo: parseTerm(pc.termDesc, pc.termCode), courses: [] });
      }
      termMap.get(termKey).courses.push(pc);
    }

    // ── Sort terms chronologically ────────────────────────────────────────
    const termOrder = { Spring: 0, Summer: 1, Fall: 2, Other: 3 };
    const sortedTerms = [...termMap.values()].sort((a, b) => {
      const yearDiff = (a.termInfo.year ?? 0) - (b.termInfo.year ?? 0);
      if (yearDiff !== 0) return yearDiff;
      return (termOrder[a.termInfo.term] ?? 3) - (termOrder[b.termInfo.term] ?? 3);
    });

    // ── Get existing semester plans to detect duplicates ──────────────────
    const existingPlans = await StudentSemesterPlan.find({ userId, cohortId }).lean();
    const existingPlansByLabel = new Map(existingPlans.map((p) => [p.label.trim(), p]));
    const maxOrder = existingPlans.reduce((m, p) => Math.max(m, p.orderIndex ?? 0), -1);

    let semesterCount = 0;
    let courseCount   = 0;
    let skippedCount  = 0;
    let orderOffset   = maxOrder + 1;

    // ── Upsert semester plans and planned courses ─────────────────────────
    for (const { termInfo, courses } of sortedTerms) {
      const label  = termInfo.label;
      const status = termStatus(termInfo.termCode, courses);

      let plan = existingPlansByLabel.get(label.trim());
      if (!plan) {
        plan = await StudentSemesterPlan.create({
          userId,
          cohortId,
          label,
          year:       termInfo.year,
          term:       ['Fall','Spring','Summer','Other'].includes(termInfo.term) ? termInfo.term : 'Other',
          termCode:   termInfo.termCode || null,
          orderIndex: orderOffset++,
          status,
          notes: 'Imported from Howdy Degree Plan.',
        });
        plan = plan.toObject();
        semesterCount++;
      }

      // Fetch existing planned courses in this semester to skip duplicates
      const existingCodes = new Set(
        (await StudentPlannedCourse.find({ userId, semesterPlanId: plan._id }, { code: 1 }).lean())
          .map((r) => r.code)
      );

      const toInsert = [];
      for (const pc of courses) {
        if (existingCodes.has(pc.code)) {
          skippedCount++;
          continue;
        }
        toInsert.push({
          userId,
          cohortId,
          semesterPlanId: plan._id,
          subject:     pc.subject,
          number:      pc.number,
          code:        pc.code,
          title:       pc.title,
          creditHours: pc.creditHours,
          status:      pc.status,
          source:      'transcript_import',
          transfer:    !!pc.transfer,
          honors:      false,
        });
        courseCount++;
      }

      if (toInsert.length > 0) {
        await StudentPlannedCourse.insertMany(toInsert, { ordered: false });
      }
    }

    // Any existing (non-locked) submission may now have stale classifications
    // because completed/in-progress courses affect prereq eligibility.
    await StudentSubmission.updateMany(
      { userId, cohortId, status: { $ne: 'locked' } },
      { $set: { classificationStale: true } }
    );

    return res.json({
      created:  { semesters: semesterCount, courses: courseCount },
      skipped:  skippedCount,
      warnings,
    });

  } catch (err) {
    console.error('[howdyImport] Error:', err);
    return res.status(500).json({ error: 'Import failed.', detail: err.message });
  }
});

module.exports = router;
