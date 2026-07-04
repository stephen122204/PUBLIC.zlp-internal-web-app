'use strict';
const express = require('express');
const mongoose = require('mongoose');
const { resolveStudentContext } = require('../../middleware/auth');
const {
  getStudentActiveCohort,
  getActiveSchedulingCycleForCohort,
  getCurrentCycleForCohort,
  getCycleSubmissionError,
  canEditSubmission,
} = require('../../lib/submissionHelpers');
const StudentCourseRequest = require('../../models/StudentCourseRequest');
const SectionPreference = require('../../models/SectionPreference');
const StudentSubmission = require('../../models/StudentSubmission');
const { classifyStudentCourseRequests } = require('../../lib/courseClassifier');

const router = express.Router();
const { getCourseSections } = require('../../lib/courseSections');
const { loadCourseHours } = require('../../lib/courseSearch');

// ---------------------------------------------------------------------------
// Helper: attach preferredSections to an array of lean course-request docs
// ---------------------------------------------------------------------------
async function attachSections(requests) {
  if (requests.length === 0) return [];
  const ids = requests.map((r) => r._id);
  const prefs = await SectionPreference.find({ courseRequestId: { $in: ids } }).lean();
  const map = {};
  for (const p of prefs) {
    const key = p.courseRequestId.toString();
    if (!map[key]) map[key] = [];
    map[key].push({ crn: p.crn, section: p.section, instructorLabel: p.instructorLabel, meetings: p.meetings });
  }
  return requests.map((r) => ({
    id: r._id,
    subject: r.subject,
    number: r.number,
    code: r.code,
    title: r.title,
    termCode: r.termCode,
    campus: r.campus,
    schedulingCycleId: r.schedulingCycleId ?? null,
    creditHours: r.creditHours ?? null,
    systemClassification: r.systemClassification,
    finalClassification: r.finalClassification,
    classificationReason: r.classificationReason,
    classificationWarnings: r.classificationWarnings ?? [],
    finalClassificationReason: r.finalClassificationReason ?? null,
    overrideStatus: r.overrideStatus ?? 'none',
    classifiedAt: r.classifiedAt ?? null,
    preferredSections: map[r._id.toString()] ?? [],
  }));
}

// ---------------------------------------------------------------------------
// GET /api/student/course-requests
// ---------------------------------------------------------------------------
router.get('/', resolveStudentContext, async (req, res) => {
  try {
    const cohort = await getStudentActiveCohort(req.studentUser._id);
    if (!cohort) return res.json({ requests: [], submission: null });

    const cycle = await getCurrentCycleForCohort(cohort._id);

    const cycleFilter = cycle
      ? { schedulingCycleId: cycle._id }
      : { schedulingCycleId: { $exists: false } };

    const [rawRequests, submission] = await Promise.all([
      StudentCourseRequest.find({ userId: req.studentUser._id, cohortId: cohort._id, ...cycleFilter })
        .sort({ createdAt: 1 })
        .lean(),
      cycle
        ? StudentSubmission.findOne({ userId: req.studentUser._id, cohortId: cohort._id, schedulingCycleId: cycle._id }).lean()
        : Promise.resolve(null),
    ]);

    const requests = await attachSections(rawRequests);

    return res.json({
      requests,
      submission: submission
        ? { status: submission.status, submittedAt: submission.submittedAt, lastEditedAt: submission.lastEditedAt }
        : null,
    });
  } catch (err) {
    console.error('[student/course-requests GET]', err);
    return res.status(500).json({ error: 'Failed to load course requests.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/student/course-requests
// Body: { subject, number, title, college, campus }
// ---------------------------------------------------------------------------
router.post('/', resolveStudentContext, async (req, res) => {
  try {
    const { subject, number, title, college, campus } = req.body;
    if (!subject || !number) {
      return res.status(400).json({ error: 'subject and number are required.' });
    }

    const cohort = await getStudentActiveCohort(req.studentUser._id);
    if (!cohort) return res.status(400).json({ error: 'Not enrolled in any active cohort.' });

    const cycle = await getCurrentCycleForCohort(cohort._id);
    if (!cycle) return res.status(400).json({ error: 'No active scheduling cycle.' });

    if (!canEditSubmission(cycle)) return res.status(400).json({ error: 'This scheduling cycle is not currently accepting submissions.' });

    const code = `${String(subject).trim().toUpperCase()} ${String(number).trim()}`;

    // Look up credit hours — prefer local course-hours.json, fall back to Howdy live fetch
    let creditHours = null;
    try {
      const hours = loadCourseHours();
      const key = `${String(subject).trim().toUpperCase()} ${String(number).trim()}`;
      if (hours[key] != null) {
        creditHours = hours[key];
      } else {
        const sections = await getCourseSections(subject, number, cycle.termCode);
        if (sections.length > 0 && sections[0].hoursLow != null) {
          creditHours = sections[0].hoursLow;
        }
      }
    } catch (sectionErr) {
      console.warn('[student/course-requests POST] credit hours lookup failed:', sectionErr.message);
    }

    const request = await StudentCourseRequest.findOneAndUpdate(
      { userId: req.studentUser._id, cohortId: cohort._id, schedulingCycleId: cycle._id, code },
      {
        subject: String(subject).trim().toUpperCase(),
        number: String(number).trim(),
        title: title ?? '',
        college: college ?? '',
        campus: campus ?? 'college-station',
        termCode: cycle.termCode,
        schedulingCycleId: cycle._id,
        systemClassification: 'unclassified',
        finalClassification: 'unclassified',
        classificationReason: 'Classification pending.',
        ...(creditHours != null ? { creditHours } : {}),
      },
      { new: true, upsert: true }
    ).lean();

    // Ensure a draft submission record exists for this cycle.
    // If already submitted, mark that the live draft has changed since last snapshot.
    // Mark classification stale since the course list changed.
    const existingSub = await StudentSubmission.findOne({
      userId: req.studentUser._id, cohortId: cohort._id, schedulingCycleId: cycle._id,
    }).lean();
    const draftFields = { lastEditedAt: new Date(), classificationStale: true };
    if (existingSub?.status === 'submitted') {
      draftFields.draftUpdatedAfterSubmit = true;
      draftFields.draftUpdatedAt = new Date();
    }
    await StudentSubmission.findOneAndUpdate(
      { userId: req.studentUser._id, cohortId: cohort._id, schedulingCycleId: cycle._id },
      { $setOnInsert: { status: 'draft' }, ...draftFields },
      { upsert: true }
    );

    const prefs = await SectionPreference.find({ courseRequestId: request._id }).lean();

    return res.status(201).json({
      request: {
        id: request._id,
        subject: request.subject,
        number: request.number,
        code: request.code,
        title: request.title,
        termCode: request.termCode,
        campus: request.campus,
        schedulingCycleId: request.schedulingCycleId,
        creditHours: request.creditHours ?? null,
        systemClassification: request.systemClassification,
        finalClassification: request.finalClassification,
        classificationReason: request.classificationReason,
        preferredSections: prefs.map((p) => ({
          crn: p.crn,
          section: p.section,
          instructorLabel: p.instructorLabel,
          meetings: p.meetings,
        })),
      },
    });
  } catch (err) {
    console.error('[student/course-requests POST]', err);
    return res.status(500).json({ error: 'Failed to add course request.' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/student/course-requests/:id
// ---------------------------------------------------------------------------
router.delete('/:id', resolveStudentContext, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid id.' });
    }

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

    const request = await StudentCourseRequest.findOne({
      _id: req.params.id,
      userId: req.studentUser._id,
      cohortId: cohort._id,
      schedulingCycleId: cycle._id,
    });
    if (!request) return res.status(404).json({ error: 'Course request not found.' });

    await SectionPreference.deleteMany({ courseRequestId: request._id });
    await request.deleteOne();

    const deleteSub = await StudentSubmission.findOne({
      userId: req.studentUser._id, cohortId: cohort._id, schedulingCycleId: cycle._id,
    }).lean();
    const deleteFields = { lastEditedAt: new Date(), classificationStale: true };
    if (deleteSub?.status === 'submitted') {
      deleteFields.draftUpdatedAfterSubmit = true;
      deleteFields.draftUpdatedAt = new Date();
    }
    await StudentSubmission.updateOne(
      { userId: req.studentUser._id, cohortId: cohort._id, schedulingCycleId: cycle._id },
      deleteFields
    );

    return res.json({ success: true });
  } catch (err) {
    console.error('[student/course-requests DELETE]', err);
    return res.status(500).json({ error: 'Failed to delete course request.' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/student/course-requests/:id/section-preferences
// Body: { sections: [{ crn, section, instructorLabel, meetings }] }
// ---------------------------------------------------------------------------
router.put('/:id/section-preferences', resolveStudentContext, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid id.' });
    }

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

    const request = await StudentCourseRequest.findOne({
      _id: req.params.id,
      userId: req.studentUser._id,
      cohortId: cohort._id,
      schedulingCycleId: cycle._id,
    });
    if (!request) return res.status(404).json({ error: 'Course request not found.' });

    const { sections = [] } = req.body;

    await SectionPreference.deleteMany({ courseRequestId: request._id });
    if (sections.length > 0) {
      const docs = sections.map((s) => ({
        courseRequestId: request._id,
        userId: req.studentUser._id,
        cohortId: cohort._id,
        schedulingCycleId: cycle._id,
        termCode: cycle.termCode,
        crn: s.crn,
        section: s.section ?? '',
        instructorLabel: s.instructorLabel ?? '',
        meetings: s.meetings ?? [],
      }));
      await SectionPreference.insertMany(docs, { ordered: false });
    }

    const secPrefSub = await StudentSubmission.findOne({
      userId: req.studentUser._id, cohortId: cohort._id, schedulingCycleId: cycle._id,
    }).lean();
    const secPrefFields = { lastEditedAt: new Date() };
    if (secPrefSub?.status === 'submitted') {
      secPrefFields.draftUpdatedAfterSubmit = true;
      secPrefFields.draftUpdatedAt = new Date();
    }
    await StudentSubmission.updateOne(
      { userId: req.studentUser._id, cohortId: cohort._id, schedulingCycleId: cycle._id },
      secPrefFields
    );

    const savedPrefs = await SectionPreference.find({ courseRequestId: request._id }).lean();

    return res.json({
      request: {
        id: request._id,
        code: request.code,
        preferredSections: savedPrefs.map((p) => ({
          crn: p.crn,
          section: p.section,
          instructorLabel: p.instructorLabel,
          meetings: p.meetings,
        })),
      },
    });
  } catch (err) {
    console.error('[student/course-requests PUT sections]', err);
    return res.status(500).json({ error: 'Failed to save section preferences.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/student/course-requests/reclassify
// Classify current student's course requests for the active cycle.
// ---------------------------------------------------------------------------
router.post('/reclassify', resolveStudentContext, async (req, res) => {
  try {
    const cohort = await getStudentActiveCohort(req.studentUser._id);
    if (!cohort) return res.status(400).json({ error: 'Not enrolled in any active cohort.' });

    // Cycle is optional — classifier still runs without it (offering check is skipped)
    const cycle = await getActiveSchedulingCycleForCohort(cohort._id);

    const updated = await classifyStudentCourseRequests({
      userId:              req.studentUser._id,
      cohortId:            cohort._id,
      schedulingCycleId:   cycle?._id ?? null,
    });

    // Classification is now fresh — clear the stale flag
    await StudentSubmission.updateMany(
      { userId: req.studentUser._id, cohortId: cohort._id, status: { $ne: 'locked' } },
      { $set: { classificationStale: false } }
    );

    const { results, runWarnings } = updated;

    // Sync courseSnapshot classification fields for submitted submissions.
    // The algorithm reads snapshots (not live records) for submitted students,
    // so the snapshot must stay in sync with finalClassification after reclassify.
    if (cycle && results.length > 0) {
      const reqMap = new Map(results.map((r) => [r._id.toString(), r]));
      const submittedSubs = await StudentSubmission.find({
        userId: req.studentUser._id,
        cohortId: cohort._id,
        schedulingCycleId: cycle._id,
        status: 'submitted',
      }).lean();
      for (const sub of submittedSubs) {
        if (!Array.isArray(sub.courseSnapshot) || sub.courseSnapshot.length === 0) continue;
        const updatedSnapshot = sub.courseSnapshot.map((snap) => {
          const live = snap.originalCourseRequestId
            ? reqMap.get(snap.originalCourseRequestId.toString())
            : null;
          if (!live) return snap;
          return {
            ...snap,
            systemClassification:      live.systemClassification,
            finalClassification:       live.finalClassification,
            classificationReason:      live.classificationReason,
            classificationWarnings:    live.classificationWarnings ?? [],
            finalClassificationReason: live.finalClassificationReason ?? null,
            overrideStatus:            live.overrideStatus ?? 'none',
          };
        });
        await StudentSubmission.updateOne(
          { _id: sub._id },
          { $set: { courseSnapshot: updatedSnapshot } }
        );
      }
    }

    const requests = await attachSections(results);
    return res.json({ requests, runWarnings: runWarnings ?? [] });
  } catch (err) {
    console.error('[course-requests reclassify]', err);
    return res.status(500).json({ error: err.message ?? 'Failed to reclassify course requests.' });
  }
});

module.exports = router;
