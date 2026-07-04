'use strict';
const express = require('express');
const { resolveStudentContext } = require('../../middleware/auth');
const {
  getStudentActiveCohort,
  getActiveSchedulingCycleForCohort,
  getCurrentCycleForCohort,
  getCycleSubmissionError,
  canEditSubmission,
} = require('../../lib/submissionHelpers');
const StudentSubmission = require('../../models/StudentSubmission');
const StudentCourseRequest = require('../../models/StudentCourseRequest');
const SectionPreference = require('../../models/SectionPreference');
const DegreePlanSelection = require('../../models/DegreePlanSelection');
const StudentAcademicProfile = require('../../models/StudentAcademicProfile');

const router = express.Router();

// ---------------------------------------------------------------------------
// Shared helper: build the full submission payload for a user+cohort+cycle
// ---------------------------------------------------------------------------
async function buildPayload(userId, cohortId, cycleId) {
  const cycleFilter = cycleId ? { schedulingCycleId: cycleId } : { schedulingCycleId: { $exists: false } };

  const [submission, sel, rawRequests] = await Promise.all([
    cycleId
      ? StudentSubmission.findOne({ userId, cohortId, schedulingCycleId: cycleId }).lean()
      : StudentSubmission.findOne({ userId, cohortId, schedulingCycleId: { $exists: false } }).lean(),
    DegreePlanSelection.findOne({ userId, cohortId }).lean(),
    StudentCourseRequest.find({ userId, cohortId, ...cycleFilter }).sort({ createdAt: 1 }).lean(),
  ]);

  const requestIds = rawRequests.map((r) => r._id);
  const prefs = await SectionPreference.find({ courseRequestId: { $in: requestIds } }).lean();
  const prefMap = {};
  for (const p of prefs) {
    const key = p.courseRequestId.toString();
    if (!prefMap[key]) prefMap[key] = [];
    prefMap[key].push({ crn: p.crn, section: p.section, instructorLabel: p.instructorLabel, meetings: p.meetings });
  }

  const requests = rawRequests.map((r) => ({
    id: r._id,
    subject: r.subject,
    number: r.number,
    code: r.code,
    title: r.title,
    termCode: r.termCode,
    campus: r.campus,
    creditHours: r.creditHours ?? null,
    systemClassification: r.systemClassification,
    finalClassification: r.finalClassification,
    classificationReason: r.classificationReason,
    classificationWarnings: r.classificationWarnings ?? [],
    finalClassificationReason: r.finalClassificationReason ?? null,
    overrideStatus: r.overrideStatus ?? 'none',
    classifiedAt: r.classifiedAt ?? null,
    preferredSections: prefMap[r._id.toString()] ?? [],
  }));

  return {
    submission: submission
      ? {
          status: submission.status,
          submittedAt: submission.submittedAt,
          lastEditedAt: submission.lastEditedAt,
          draftUpdatedAfterSubmit: submission.draftUpdatedAfterSubmit ?? false,
          draftUpdatedAt: submission.draftUpdatedAt ?? null,
          snapshotVersion: submission.snapshotVersion ?? 0,
          lastSubmittedAt: submission.lastSubmittedAt ?? null,
          classificationStale: submission.classificationStale ?? false,
        }
      : null,
    degreePlanSelection: sel
      ? { planId: sel.planId, planTitle: sel.planTitle, catalog: sel.catalog, updatedAt: sel.updatedAt }
      : null,
    requests,
  };
}

// ---------------------------------------------------------------------------
// GET /api/student/submission
// ---------------------------------------------------------------------------
router.get('/', resolveStudentContext, async (req, res) => {
  try {
    const cohort = await getStudentActiveCohort(req.studentUser._id);
    if (!cohort) return res.json({ submission: null, degreePlanSelection: null, requests: [], activeCycle: null });

    const cycle = await getCurrentCycleForCohort(cohort._id);
    const payload = await buildPayload(req.studentUser._id, cohort._id, cycle ? cycle._id : null);

    return res.json({
      ...payload,
      activeCycle: cycle
        ? { id: cycle._id, term: cycle.term, termCode: cycle.termCode, status: cycle.status }
        : null,
    });
  } catch (err) {
    console.error('[student/submission GET]', err);
    return res.status(500).json({ error: 'Failed to load submission.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/student/submission
// ---------------------------------------------------------------------------
router.post('/', resolveStudentContext, async (req, res) => {
  try {
    const cohort = await getStudentActiveCohort(req.studentUser._id);
    if (!cohort) return res.status(400).json({ error: 'Not enrolled in any active cohort.' });

    const cycle = await getActiveSchedulingCycleForCohort(cohort._id);
    if (!cycle) {
      const errMsg = await getCycleSubmissionError(cohort._id);
      if (errMsg) return res.status(403).json({ error: errMsg });
      return res.status(400).json({ error: 'No registration cycle is currently open for your cohort.' });
    }

    if (!canEditSubmission(cycle)) {
      return res.status(403).json({ error: 'The submission deadline has passed.' });
    }

    const [sel, profile, courseCount] = await Promise.all([
      DegreePlanSelection.findOne({ userId: req.studentUser._id, cohortId: cohort._id }).lean(),
      StudentAcademicProfile.findOne({ userId: req.studentUser._id, cohortId: cohort._id }).lean(),
      StudentCourseRequest.countDocuments({ userId: req.studentUser._id, cohortId: cohort._id, schedulingCycleId: cycle._id }),
    ]);

    // Use student's draft major (pending selection) if present, else canonical
    const effectivePrimaryMajorId = (profile?.studentDraft?.primaryMajor ?? profile?.primaryMajor)?.programId ?? null;
    if (!sel && !effectivePrimaryMajorId) {
      return res.status(400).json({ error: 'Please select a degree plan before submitting.' });
    }
    if (courseCount === 0) {
      return res.status(400).json({ error: 'Please add at least one course before submitting.' });
    }

    // Block submission when classifications are stale
    const existingSubForStaleCheck = await StudentSubmission.findOne({
      userId: req.studentUser._id, cohortId: cohort._id, schedulingCycleId: cycle._id,
    }).lean();
    if (existingSubForStaleCheck?.classificationStale === true) {
      return res.status(400).json({
        error: 'Your course classifications are out of date. Please refresh classification before submitting.',
      });
    }

    // Block submission if Required + Preferred credit hours exceed the limit
    // (unless an admin has granted a credit-hour override for this student)
    const SUBMISSION_CREDIT_LIMIT = 17;
    const allRequestsForCreditCheck = await StudentCourseRequest.find({
      userId: req.studentUser._id,
      cohortId: cohort._id,
      schedulingCycleId: cycle._id,
    }, { finalClassification: 1, creditHours: 1 }).lean();
    const submissionHours = allRequestsForCreditCheck
      .filter((r) => r.finalClassification === 'required' || r.finalClassification === 'preferred')
      .reduce((sum, r) => sum + (Number(r.creditHours) || 0), 0);
    const creditOverrideActive = profile?.allowOverCreditSubmission === true;
    if (submissionHours > SUBMISSION_CREDIT_LIMIT && !creditOverrideActive) {
      return res.status(400).json({
        error: `You have ${submissionHours} credit hours marked Required or Preferred. Students may submit at most ${SUBMISSION_CREDIT_LIMIT} credit hours unless an admin override is approved.`,
        submissionHours,
        submissionCreditLimit: SUBMISSION_CREDIT_LIMIT,
        creditOverrideActive: false,
      });
    }

    const now = new Date();

    // Build frozen snapshot from live course requests + section preferences
    const liveRequests = await StudentCourseRequest.find({
      userId: req.studentUser._id,
      cohortId: cohort._id,
      schedulingCycleId: cycle._id,
    }).lean();

    const reqIds = liveRequests.map((r) => r._id);
    const livePrefs = await SectionPreference.find({ courseRequestId: { $in: reqIds } }).lean();
    const prefMap = {};
    for (const p of livePrefs) {
      const key = p.courseRequestId.toString();
      if (!prefMap[key]) prefMap[key] = [];
      prefMap[key].push({
        crn: p.crn,
        section: p.section ?? '',
        instructorLabel: p.instructorLabel ?? '',
        meetings: p.meetings ?? [],
        termCode: p.termCode ?? cycle.termCode,
      });
    }

    const courseSnapshot = liveRequests.map((r) => ({
      originalCourseRequestId: r._id,
      subject: r.subject,
      number: r.number,
      code: r.code,
      title: r.title,
      creditHours: r.creditHours ?? null,
      systemClassification: r.systemClassification,
      finalClassification: r.finalClassification,
      classificationReason: r.classificationReason,
      classificationWarnings: r.classificationWarnings ?? [],
      finalClassificationReason: r.finalClassificationReason ?? null,
      overrideStatus: r.overrideStatus ?? 'none',
      preferredSections: prefMap[r._id.toString()] ?? [],
      snapshotAt: now,
    }));

    const submission = await StudentSubmission.findOneAndUpdate(
      { userId: req.studentUser._id, cohortId: cohort._id, schedulingCycleId: cycle._id },
      {
        $set: {
          status: 'submitted',
          submittedAt: now,
          lastEditedAt: now,
          lastSubmittedAt: now,
          lastSubmittedBy: req.studentUser._id,
          courseSnapshot,
          degreePlanSnapshot: sel
            ? { planId: sel.planId ?? null, planTitle: sel.planTitle ?? null, catalog: sel.catalog ?? null }
            : null,
          profileSnapshot: {
            // Snapshot uses the effective profile (student draft overrides canonical)
            primaryMajor:            (profile?.studentDraft?.primaryMajor     ?? profile?.primaryMajor)     ?? null,
            additionalMajors:        (profile?.studentDraft?.additionalMajors ?? profile?.additionalMajors) ?? [],
            minors:                  (profile?.studentDraft?.minors           ?? profile?.minors)           ?? [],
            catalogYear:             profile?.catalogYear ?? null,
            secondaryProgramEnabled: profile?.secondaryProgramEnabled ?? false,
          },
          draftUpdatedAfterSubmit: false,
          draftUpdatedAt: null,
        },
        $inc: { snapshotVersion: 1 },
      },
      { new: true, upsert: true }
    ).lean();

    // Promote student draft to canonical so the admin can see the student's
    // confirmed selection after submission.
    if (profile?._id && profile.studentDraft) {
      try {
        await StudentAcademicProfile.findByIdAndUpdate(profile._id, {
          $set: {
            primaryMajor:     profile.studentDraft.primaryMajor     ?? profile.primaryMajor,
            additionalMajors: profile.studentDraft.additionalMajors ?? profile.additionalMajors,
            minors:           profile.studentDraft.minors           ?? profile.minors,
          },
          $unset: { studentDraft: 1 },
        });
      } catch (draftErr) {
        console.error('[student/submission POST] draft promotion failed (non-fatal):', draftErr);
      }
    }

    return res.json({
      success: true,
      submission: {
        status: submission.status,
        submittedAt: submission.submittedAt,
        lastEditedAt: submission.lastEditedAt,
        draftUpdatedAfterSubmit: false,
        draftUpdatedAt: null,
        snapshotVersion: submission.snapshotVersion ?? 1,
        lastSubmittedAt: submission.lastSubmittedAt,
      },
      message: 'Your planned courses have been submitted to the program director.',
    });
  } catch (err) {
    console.error('[student/submission POST]', err);
    return res.status(500).json({ error: 'Failed to submit.' });
  }
});

module.exports = router;
