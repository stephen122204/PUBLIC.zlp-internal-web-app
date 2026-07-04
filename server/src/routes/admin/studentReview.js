'use strict';
const express = require('express');
const mongoose = require('mongoose');
const { requireAdmin } = require('../../middleware/auth');
const { getActiveSchedulingCycleForCohort, getCurrentCycleForCohort } = require('../../lib/submissionHelpers');
const User = require('../../models/User');
const Cohort = require('../../models/Cohort');
const CohortMember = require('../../models/CohortMember');
const SchedulingCycle = require('../../models/SchedulingCycle');
const StudentCourseRequest = require('../../models/StudentCourseRequest');
const SectionPreference = require('../../models/SectionPreference');
const StudentSubmission = require('../../models/StudentSubmission');
const DegreePlanSelection = require('../../models/DegreePlanSelection');
const StudentAcademicProfile = require('../../models/StudentAcademicProfile');
const { classifyStudentCourseRequests } = require('../../lib/courseClassifier');

const { getCourseSections } = require('../../lib/courseSections');
const { getCourseGradeStats } = require('../../lib/gradeDistributions');
const { attachSyllabusLinks } = require('../../lib/syllabusResolver');

const router = express.Router();

// All routes in this file require admin (or developer, which passes requireAdmin)
router.use(requireAdmin);

// ---------------------------------------------------------------------------
// Helper: build the full course-request shape (with new override fields)
// ---------------------------------------------------------------------------
async function buildCourseRequests(requests) {
  if (requests.length === 0) return [];
  const ids = requests.map((r) => r._id);
  const prefs = await SectionPreference.find({ courseRequestId: { $in: ids } }).lean();
  const prefMap = {};
  for (const p of prefs) {
    const key = p.courseRequestId.toString();
    if (!prefMap[key]) prefMap[key] = [];
    prefMap[key].push({ crn: p.crn, section: p.section, instructorLabel: p.instructorLabel, meetings: p.meetings });
  }
  return requests.map((r) => ({
    id: r._id,
    code: r.code,
    subject: r.subject,
    number: r.number,
    title: r.title,
    college: r.college,
    campus: r.campus,
    termCode: r.termCode,
    creditHours: r.creditHours ?? null,
    systemClassification: r.systemClassification,
    finalClassification: r.finalClassification,
    classificationReason: r.classificationReason,
    finalClassificationReason: r.finalClassificationReason ?? null,
    overrideStatus: r.overrideStatus ?? 'none',
    overrideUpdatedBy: r.overrideUpdatedBy ?? null,
    overrideUpdatedAt: r.overrideUpdatedAt ?? null,
    preferredSections: prefMap[r._id.toString()] ?? [],
  }));
}

// ---------------------------------------------------------------------------
// GET /api/admin/students/:studentId/submission
// Query: cohortId (required), cycleId (optional – defaults to active cycle)
// ---------------------------------------------------------------------------
router.get('/students/:studentId/submission', async (req, res) => {
  try {
    const { studentId } = req.params;
    const { cohortId, cycleId } = req.query;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({ error: 'Invalid studentId.' });
    }
    if (!cohortId || !mongoose.Types.ObjectId.isValid(cohortId)) {
      return res.status(400).json({ error: 'cohortId query param is required.' });
    }

    const [student, cohort, membership] = await Promise.all([
      User.findById(studentId).lean(),
      Cohort.findById(cohortId).lean(),
      CohortMember.findOne({ userId: studentId, cohortId }).lean(),
    ]);

    if (!student) return res.status(404).json({ error: 'Student not found.' });
    if (!cohort)  return res.status(404).json({ error: 'Cohort not found.' });
    if (!membership) return res.status(404).json({ error: 'Student is not a member of this cohort.' });

    // Resolve cycle
    let cycle = null;
    if (cycleId && mongoose.Types.ObjectId.isValid(cycleId)) {
      cycle = await SchedulingCycle.findOne({ _id: cycleId, cohortId }).lean();
    } else {
      cycle = await getCurrentCycleForCohort(cohortId);
    }

    const [degreePlanSel, academicProfile] = await Promise.all([
      DegreePlanSelection.findOne({ userId: studentId, cohortId }).lean(),
      StudentAcademicProfile.findOne({ userId: studentId, cohortId }).lean(),
    ]);

    let courseRequests = [];
    let submission = null;
    let dataSource = 'live';
    let resolvedDegreePlan = null;
    if (cycle) {
      const [rawRequests, sub] = await Promise.all([
        StudentCourseRequest.find({ userId: studentId, cohortId, schedulingCycleId: cycle._id }).sort({ createdAt: 1 }).lean(),
        StudentSubmission.findOne({ userId: studentId, cohortId, schedulingCycleId: cycle._id }).lean(),
      ]);

      // If submitted and a frozen snapshot exists, serve the snapshot to admin.
      // Live draft changes after the snapshot are NOT shown here — admin sees what was actually submitted.
      if (sub && sub.status === 'submitted' && Array.isArray(sub.courseSnapshot) && sub.courseSnapshot.length > 0) {
        dataSource = 'snapshot';
        courseRequests = sub.courseSnapshot.map((snap) => ({
          id: snap.originalCourseRequestId,
          code: snap.code,
          subject: snap.subject,
          number: snap.number,
          title: snap.title,
          college: null,
          campus: null,
          termCode: null,
          creditHours: snap.creditHours ?? null,
          systemClassification: snap.systemClassification,
          finalClassification: snap.finalClassification,
          classificationReason: snap.classificationReason,
          classificationWarnings: snap.classificationWarnings ?? [],
          finalClassificationReason: snap.finalClassificationReason ?? null,
          overrideStatus: snap.overrideStatus ?? 'none',
          overrideUpdatedBy: null,
          overrideUpdatedAt: null,
          preferredSections: snap.preferredSections ?? [],
        }));
      } else {
        dataSource = 'live';
        courseRequests = await buildCourseRequests(rawRequests);
      }

      submission = sub
        ? {
            status: sub.status,
            submittedAt: sub.submittedAt,
            lastEditedAt: sub.lastEditedAt,
            draftUpdatedAfterSubmit: sub.draftUpdatedAfterSubmit ?? false,
            draftUpdatedAt: sub.draftUpdatedAt ?? null,
            snapshotVersion: sub.snapshotVersion ?? 0,
            lastSubmittedAt: sub.lastSubmittedAt ?? null,
          }
        : null;

      // Degree plan selection uses the snapshot if available
      if (sub?.degreePlanSnapshot) resolvedDegreePlan = sub.degreePlanSnapshot;
      // Note: academicProfile intentionally always uses the live profile (not the snapshot)
      // so that admin edits to the major/minors are immediately visible without re-submitting.
    }

    return res.json({
      student: { id: student._id, name: student.name, email: student.email, isDummy: student.isDummy ?? false },
      cohort:  { id: cohort._id,  name: cohort.name,  active: cohort.active },
      cycle:   cycle ? { id: cycle._id, term: cycle.term, termCode: cycle.termCode, status: cycle.status } : null,
      degreePlanSelection: (() => {
        const src = resolvedDegreePlan ?? degreePlanSel;
        if (!src) return null;
        return { planId: src.planId ?? null, planTitle: src.planTitle ?? null, catalog: src.catalog ?? null };
      })(),
      academicProfile: (() => {
        if (!academicProfile) return null;
        // Always use canonical (not draft) — admin sees the last submitted/admin-set
        // major. Draft is only promoted to canonical when the student submits.
        // Admin edits write directly to canonical and clear the draft, so they
        // are always reflected immediately without needing the draft overlay.
        const effectiveCatalogYear = academicProfile.catalogYear || cohort.catalogYear || null;
        const catalogYearSource =
          academicProfile.catalogYear && academicProfile.catalogYear !== cohort.catalogYear
            ? 'student_override'
            : 'cohort_default';
        return {
          primaryMajor:                academicProfile.primaryMajor ?? null,
          additionalMajors:            academicProfile.additionalMajors ?? [],
          minors:                      academicProfile.minors ?? [],
          catalogYear:                 academicProfile.catalogYear ?? null,
          effectiveCatalogYear,
          catalogYearSource,
          secondaryProgramEnabled:     academicProfile.secondaryProgramEnabled ?? false,
          allowOverCreditSubmission:   academicProfile.allowOverCreditSubmission ?? false,
          allowOverCreditSubmissionBy: academicProfile.allowOverCreditSubmissionBy ?? null,
          allowOverCreditSubmissionAt: academicProfile.allowOverCreditSubmissionAt ?? null,
        };
      })(),
      cohortCatalogYear: cohort.catalogYear ?? null,
      submission,
      courseRequests,
      dataSource,
    });
  } catch (err) {
    console.error('[admin/students/submission GET]', err);
    return res.status(500).json({ error: 'Failed to load student submission.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/students/:studentId/course-requests
// Body: { cohortId, cycleId, subject, number, code?, title?, college?, campus? }
// Admin adds a course to a student's submission
// ---------------------------------------------------------------------------
router.post('/students/:studentId/course-requests', async (req, res) => {
  try {
    const { studentId } = req.params;
    const { cohortId, cycleId, subject, number, title, college, campus } = req.body;

    if (!mongoose.Types.ObjectId.isValid(studentId)) return res.status(400).json({ error: 'Invalid studentId.' });
    if (!cohortId || !mongoose.Types.ObjectId.isValid(cohortId)) return res.status(400).json({ error: 'cohortId is required.' });
    if (!cycleId  || !mongoose.Types.ObjectId.isValid(cycleId))  return res.status(400).json({ error: 'cycleId is required.' });
    if (!subject || !number) return res.status(400).json({ error: 'subject and number are required.' });

    const cycle = await SchedulingCycle.findById(cycleId).lean();
    if (!cycle) return res.status(404).json({ error: 'Scheduling cycle not found.' });

    const code = `${String(subject).trim().toUpperCase()} ${String(number).trim()}`;

    // Look up credit hours from Howdy sections (best-effort)
    let creditHours = null;
    try {
      const sections = await getCourseSections(subject, number, cycle.termCode);
      if (sections.length > 0 && sections[0].hoursLow != null) {
        creditHours = sections[0].hoursLow;
      }
    } catch (sectionErr) {
      console.warn('[admin/course-requests POST] credit hours lookup failed:', sectionErr.message);
    }

    const request = await StudentCourseRequest.findOneAndUpdate(
      { userId: studentId, cohortId, schedulingCycleId: cycleId, code },
      {
        $set: {
          subject: String(subject).trim().toUpperCase(),
          number: String(number).trim(),
          title: title ?? '',
          college: college ?? '',
          campus: campus ?? 'college-station',
          termCode: cycle.termCode,
          systemClassification: 'unclassified',
          finalClassification: 'unclassified',
          classificationReason: 'Classification pending.',
          ...(creditHours != null ? { creditHours } : {}),
        },
      },
      { new: true, upsert: true }
    ).lean();

    await StudentSubmission.findOneAndUpdate(
      { userId: studentId, cohortId, schedulingCycleId: cycleId },
      { $setOnInsert: { status: 'draft' }, $set: { lastEditedAt: new Date() } },
      { upsert: true }
    );

    // If student has a submitted snapshot, also add the course to the snapshot
    // so the admin view stays consistent without requiring a student re-submit.
    const existingSubForAdd = await StudentSubmission.findOne({ userId: studentId, cohortId, schedulingCycleId: cycleId }).lean();
    if (existingSubForAdd?.status === 'submitted' && Array.isArray(existingSubForAdd.courseSnapshot)) {
      const alreadyInSnapshot = existingSubForAdd.courseSnapshot.some(
        (s) => String(s.originalCourseRequestId) === String(request._id),
      );
      if (!alreadyInSnapshot) {
        await StudentSubmission.updateOne(
          { _id: existingSubForAdd._id },
          { $push: { courseSnapshot: {
            originalCourseRequestId: request._id,
            subject: request.subject, number: request.number, code: request.code, title: request.title ?? '',
            creditHours: request.creditHours ?? null,
            systemClassification: request.systemClassification, finalClassification: request.finalClassification,
            classificationReason: request.classificationReason, classificationWarnings: [],
            finalClassificationReason: null, overrideStatus: 'none',
            preferredSections: [], snapshotAt: new Date(),
          }}},
        );
      }
    }

    return res.status(201).json({
      request: {
        id: request._id, code: request.code, subject: request.subject, number: request.number,
        title: request.title, termCode: request.termCode, campus: request.campus,
        creditHours: request.creditHours ?? null,
        systemClassification: request.systemClassification, finalClassification: request.finalClassification,
        classificationReason: request.classificationReason, finalClassificationReason: null,
        overrideStatus: 'none', preferredSections: [],
      },
    });
  } catch (err) {
    console.error('[admin/students/course-requests POST]', err);
    return res.status(500).json({ error: 'Failed to add course request.' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/students/:studentId/course-requests/:requestId
// Query: cohortId, cycleId
// Admin removes a course request (and its section preferences)
// ---------------------------------------------------------------------------
router.delete('/students/:studentId/course-requests/:requestId', async (req, res) => {
  try {
    const { studentId, requestId } = req.params;
    const { cohortId, cycleId } = req.query;

    if (!mongoose.Types.ObjectId.isValid(studentId) || !mongoose.Types.ObjectId.isValid(requestId)) {
      return res.status(400).json({ error: 'Invalid id.' });
    }
    if (!cohortId || !mongoose.Types.ObjectId.isValid(cohortId)) return res.status(400).json({ error: 'cohortId is required.' });
    if (!cycleId  || !mongoose.Types.ObjectId.isValid(cycleId))  return res.status(400).json({ error: 'cycleId is required.' });

    const request = await StudentCourseRequest.findOne({ _id: requestId, userId: studentId, cohortId, schedulingCycleId: cycleId });
    if (!request) return res.status(404).json({ error: 'Course request not found.' });

    await SectionPreference.deleteMany({ courseRequestId: request._id });
    await request.deleteOne();

    // If student has a submitted snapshot, remove the course from it too
    const delSub = await StudentSubmission.findOne({ userId: studentId, cohortId, schedulingCycleId: cycleId }).lean();
    if (delSub?.status === 'submitted' && Array.isArray(delSub.courseSnapshot) && delSub.courseSnapshot.length > 0) {
      await StudentSubmission.updateOne(
        { _id: delSub._id },
        { $pull: { courseSnapshot: { originalCourseRequestId: request._id } }, $set: { lastEditedAt: new Date() } },
      );
    } else {
      await StudentSubmission.updateOne(
        { userId: studentId, cohortId, schedulingCycleId: cycleId },
        { $set: { lastEditedAt: new Date() } }
      );
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[admin/students/course-requests DELETE]', err);
    return res.status(500).json({ error: 'Failed to delete course request.' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/admin/students/:studentId/course-requests/:requestId/section-preferences
// Body: { sections: [{ crn, section, instructorLabel, meetings }] }
// Admin replaces preferred sections for a course request
// ---------------------------------------------------------------------------
router.put('/students/:studentId/course-requests/:requestId/section-preferences', async (req, res) => {
  try {
    const { studentId, requestId } = req.params;
    const { sections = [] } = req.body;

    if (!mongoose.Types.ObjectId.isValid(studentId) || !mongoose.Types.ObjectId.isValid(requestId)) {
      return res.status(400).json({ error: 'Invalid id.' });
    }

    const request = await StudentCourseRequest.findOne({ _id: requestId, userId: studentId });
    if (!request) return res.status(404).json({ error: 'Course request not found.' });

    await SectionPreference.deleteMany({ courseRequestId: request._id });
    if (sections.length > 0) {
      const docs = sections.map((s) => ({
        courseRequestId: request._id,
        userId: studentId,
        cohortId: request.cohortId,
        schedulingCycleId: request.schedulingCycleId,
        termCode: request.termCode,
        crn: s.crn,
        section: s.section ?? '',
        instructorLabel: s.instructorLabel ?? '',
        meetings: s.meetings ?? [],
      }));
      await SectionPreference.insertMany(docs, { ordered: false });
    }

    const savedPrefs = await SectionPreference.find({ courseRequestId: request._id }).lean();

    // Always update lastEditedAt
    await StudentSubmission.updateOne(
      { userId: studentId, cohortId: request.cohortId, schedulingCycleId: request.schedulingCycleId },
      { $set: { lastEditedAt: new Date() } }
    );

    // Sync preferredSections into the submitted snapshot so the algorithm uses updated data
    await StudentSubmission.updateOne(
      {
        userId: studentId,
        cohortId: request.cohortId,
        schedulingCycleId: request.schedulingCycleId,
        status: 'submitted',
        'courseSnapshot.originalCourseRequestId': request._id,
      },
      {
        $set: {
          'courseSnapshot.$.preferredSections': savedPrefs.map((p) => ({
            crn: p.crn,
            section: p.section ?? '',
            instructorLabel: p.instructorLabel ?? '',
            meetings: p.meetings ?? [],
            termCode: p.termCode ?? request.termCode ?? '',
          })),
        },
      }
    );

    return res.json({
      preferredSections: savedPrefs.map((p) => ({
        crn: p.crn, section: p.section, instructorLabel: p.instructorLabel, meetings: p.meetings,
      })),
    });
  } catch (err) {
    console.error('[admin/students/section-preferences PUT]', err);
    return res.status(500).json({ error: 'Failed to save section preferences.' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/students/:studentId/course-requests/:requestId/classification
// Body: { finalClassification, finalClassificationReason? }
// Admin overrides the finalClassification; systemClassification unchanged
// ---------------------------------------------------------------------------
router.patch('/students/:studentId/course-requests/:requestId/classification', async (req, res) => {
  try {
    const { studentId, requestId } = req.params;
    const { finalClassification, finalClassificationReason } = req.body;

    if (!mongoose.Types.ObjectId.isValid(studentId) || !mongoose.Types.ObjectId.isValid(requestId)) {
      return res.status(400).json({ error: 'Invalid id.' });
    }

    const allowed = ['unclassified', 'required', 'preferred', 'not_applied'];
    if (!allowed.includes(finalClassification)) {
      return res.status(400).json({ error: `finalClassification must be one of: ${allowed.join(', ')}.` });
    }

    const request = await StudentCourseRequest.findOneAndUpdate(
      { _id: requestId, userId: studentId },
      {
        finalClassification,
        finalClassificationReason: finalClassificationReason ?? null,
        overrideStatus: 'manual_override',
        overrideUpdatedBy: req.user._id,
        overrideUpdatedAt: new Date(),
      },
      { new: true }
    ).lean();

    if (!request) return res.status(404).json({ error: 'Course request not found.' });

    // Also update the frozen snapshot entry (if one exists) so algorithm and admin view stay in sync.
    await StudentSubmission.updateOne(
      {
        userId: studentId,
        cohortId: request.cohortId,
        schedulingCycleId: request.schedulingCycleId,
        status: 'submitted',
        'courseSnapshot.originalCourseRequestId': request._id,
      },
      {
        $set: {
          'courseSnapshot.$.finalClassification': finalClassification,
          'courseSnapshot.$.finalClassificationReason': finalClassificationReason ?? null,
          'courseSnapshot.$.overrideStatus': 'manual_override',
        },
      }
    );

    return res.json({
      id: request._id,
      code: request.code,
      systemClassification: request.systemClassification,
      finalClassification: request.finalClassification,
      classificationReason: request.classificationReason,
      finalClassificationReason: request.finalClassificationReason,
      overrideStatus: request.overrideStatus,
      overrideUpdatedAt: request.overrideUpdatedAt,
    });
  } catch (err) {
    console.error('[admin/students/classification PATCH]', err);
    return res.status(500).json({ error: 'Failed to update classification.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/students/:studentId/submission
// Body: { cohortId, cycleId, status: "draft"|"submitted" }
// Admin sets a student's submission status
// ---------------------------------------------------------------------------
router.post('/students/:studentId/submission', async (req, res) => {
  try {
    const { studentId } = req.params;
    const { cohortId, cycleId, status } = req.body;

    if (!mongoose.Types.ObjectId.isValid(studentId)) return res.status(400).json({ error: 'Invalid studentId.' });
    if (!cohortId || !mongoose.Types.ObjectId.isValid(cohortId)) return res.status(400).json({ error: 'cohortId is required.' });
    if (!cycleId  || !mongoose.Types.ObjectId.isValid(cycleId))  return res.status(400).json({ error: 'cycleId is required.' });
    if (!['draft', 'submitted'].includes(status)) return res.status(400).json({ error: 'status must be draft or submitted.' });

    const now = new Date();
    const setFields = { status, lastEditedAt: now };
    const updateOp = { $set: setFields };

    if (status === 'submitted') {
      setFields.submittedAt = now;
      setFields.lastSubmittedAt = now;
      setFields.lastSubmittedBy = req.user._id;
      setFields.draftUpdatedAfterSubmit = false;
      setFields.draftUpdatedAt = null;
      updateOp.$inc = { snapshotVersion: 1 };

      // Build a frozen snapshot from live course requests
      const [liveRequests, cycle_] = await Promise.all([
        StudentCourseRequest.find({ userId: studentId, cohortId, schedulingCycleId: cycleId }).lean(),
        SchedulingCycle.findById(cycleId).lean(),
      ]);
      if (liveRequests.length > 0) {
        const termCode = cycle_?.termCode ?? '';
        const reqIds = liveRequests.map((r) => r._id);
        const livePrefs = await SectionPreference.find({ courseRequestId: { $in: reqIds } }).lean();
        const prefMap = {};
        for (const p of livePrefs) {
          const key = p.courseRequestId.toString();
          if (!prefMap[key]) prefMap[key] = [];
          prefMap[key].push({ crn: p.crn, section: p.section ?? '', instructorLabel: p.instructorLabel ?? '', meetings: p.meetings ?? [], termCode: p.termCode ?? termCode });
        }
        setFields.courseSnapshot = liveRequests.map((r) => ({
          originalCourseRequestId: r._id,
          subject: r.subject, number: r.number, code: r.code, title: r.title,
          creditHours: r.creditHours ?? null,
          systemClassification: r.systemClassification, finalClassification: r.finalClassification,
          classificationReason: r.classificationReason, classificationWarnings: r.classificationWarnings ?? [],
          finalClassificationReason: r.finalClassificationReason ?? null,
          overrideStatus: r.overrideStatus ?? 'none',
          preferredSections: prefMap[r._id.toString()] ?? [],
          snapshotAt: now,
        }));
      }
    }

    const submission = await StudentSubmission.findOneAndUpdate(
      { userId: studentId, cohortId, schedulingCycleId: cycleId },
      updateOp,
      { new: true, upsert: true }
    ).lean();

    return res.json({
      status: submission.status,
      submittedAt: submission.submittedAt,
      lastEditedAt: submission.lastEditedAt,
      lastSubmittedAt: submission.lastSubmittedAt ?? null,
      draftUpdatedAfterSubmit: submission.draftUpdatedAfterSubmit ?? false,
      snapshotVersion: submission.snapshotVersion ?? 0,
    });
  } catch (err) {
    console.error('[admin/students/submission POST]', err);
    return res.status(500).json({ error: 'Failed to update submission.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/students/:studentId/reclassify
// Body: { cohortId, cycleId }
// Reclassifies a single student's course requests; preserves manual overrides.
// ---------------------------------------------------------------------------
router.post('/students/:studentId/reclassify', async (req, res) => {
  try {
    const { studentId } = req.params;
    const { cohortId, cycleId } = req.body;

    if (!mongoose.Types.ObjectId.isValid(studentId)) return res.status(400).json({ error: 'Invalid studentId.' });
    if (!cohortId || !mongoose.Types.ObjectId.isValid(cohortId)) return res.status(400).json({ error: 'cohortId is required.' });
    if (!cycleId  || !mongoose.Types.ObjectId.isValid(cycleId))  return res.status(400).json({ error: 'cycleId is required.' });

    const { results: updated } = await classifyStudentCourseRequests({
      userId:            studentId,
      cohortId,
      schedulingCycleId: cycleId,
    });

    // If student has a submitted snapshot, sync system classifications into it
    // (preserving manual overrides on final classification) and return snapshot data.
    const sub = await StudentSubmission.findOne({ userId: studentId, cohortId, schedulingCycleId: cycleId }).lean();
    if (sub?.status === 'submitted' && Array.isArray(sub.courseSnapshot) && sub.courseSnapshot.length > 0) {
      const liveMap = new Map(updated.map((r) => [String(r._id), r]));
      const updatedSnapshot = sub.courseSnapshot.map((snap) => {
        const live = liveMap.get(String(snap.originalCourseRequestId));
        if (!live) return snap; // course removed from live after submit — keep in snapshot
        const isOverridden = snap.overrideStatus === 'manual_override';
        return {
          ...snap,
          systemClassification:     live.systemClassification,
          classificationReason:     live.classificationReason,
          classificationWarnings:   live.classificationWarnings ?? [],
          finalClassification:      isOverridden ? snap.finalClassification      : live.finalClassification,
          finalClassificationReason: isOverridden ? snap.finalClassificationReason : live.finalClassificationReason,
        };
      });
      await StudentSubmission.updateOne({ _id: sub._id }, { $set: { courseSnapshot: updatedSnapshot } });
      const courseRequests = updatedSnapshot.map((snap) => ({
        id:                       snap.originalCourseRequestId,
        code:                     snap.code,
        subject:                  snap.subject,
        number:                   snap.number,
        title:                    snap.title,
        college: null, campus: null, termCode: null,
        creditHours:              snap.creditHours ?? null,
        systemClassification:     snap.systemClassification,
        finalClassification:      snap.finalClassification,
        classificationReason:     snap.classificationReason,
        classificationWarnings:   snap.classificationWarnings ?? [],
        finalClassificationReason: snap.finalClassificationReason ?? null,
        overrideStatus:           snap.overrideStatus ?? 'none',
        overrideUpdatedBy: null, overrideUpdatedAt: null,
        preferredSections:        snap.preferredSections ?? [],
      }));
      return res.json({ courseRequests });
    }

    const courseRequests = await buildCourseRequests(updated);
    return res.json({ courseRequests });
  } catch (err) {
    console.error('[admin/students/reclassify POST]', err);
    return res.status(500).json({ error: 'Failed to reclassify student course requests.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/cohorts/:cohortId/cycles/:cycleId/reclassify
// Reclassifies all students in a cohort/cycle. Returns a summary.
// ---------------------------------------------------------------------------
router.post('/cohorts/:cohortId/cycles/:cycleId/reclassify', async (req, res) => {
  try {
    const { cohortId, cycleId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(cohortId)) return res.status(400).json({ error: 'Invalid cohortId.' });
    if (!mongoose.Types.ObjectId.isValid(cycleId))  return res.status(400).json({ error: 'Invalid cycleId.' });

    // Get all members of this cohort
    const members = await CohortMember.find({ cohortId, status: 'active' }).lean();
    if (members.length === 0) return res.json({ totalStudents: 0, totalCourses: 0, required: 0, preferred: 0, notApplied: 0, unclassified: 0, warnings: [] });

    const summary = { totalStudents: 0, totalCourses: 0, required: 0, preferred: 0, notApplied: 0, unclassified: 0, warnings: [] };

    await Promise.allSettled(
      members.map(async (member) => {
        try {
          const { results: updated, runWarnings } = await classifyStudentCourseRequests({
            userId:            member.userId,
            cohortId,
            schedulingCycleId: cycleId,
          });
          summary.totalStudents += 1;
          if (runWarnings?.length) summary.warnings.push(...runWarnings.map((w) => `[${member.userId}] ${w}`));
          for (const req of updated) {
            summary.totalCourses += 1;
            // BUG-03 fix: use finalClassification (respects manual overrides) for summary counts
            if      (req.finalClassification === 'required')    summary.required    += 1;
            else if (req.finalClassification === 'preferred')   summary.preferred   += 1;
            else if (req.finalClassification === 'not_applied') summary.notApplied  += 1;
            else                                                 summary.unclassified += 1;
            if (req.classificationWarnings?.length > 0) {
              summary.warnings.push(...req.classificationWarnings.map((w) => `[${member.userId}] ${w}`));
            }
          }

          // BUG-02 fix: sync submitted snapshot if one exists, preserving manual overrides
          const sub = await StudentSubmission.findOne({
            userId:            member.userId,
            cohortId,
            schedulingCycleId: cycleId,
          }).lean();
          if (sub?.status === 'submitted' && Array.isArray(sub.courseSnapshot) && sub.courseSnapshot.length > 0) {
            const liveMap = new Map(updated.map((r) => [String(r._id), r]));
            const updatedSnapshot = sub.courseSnapshot.map((snap) => {
              const live = liveMap.get(String(snap.originalCourseRequestId));
              if (!live) return snap; // course removed from live after submit — keep in snapshot
              const isOverridden = snap.overrideStatus === 'manual_override';
              return {
                ...snap,
                systemClassification:      live.systemClassification,
                classificationReason:      live.classificationReason,
                classificationWarnings:    live.classificationWarnings ?? [],
                overrideStatus:            live.overrideStatus,
                finalClassification:       isOverridden ? snap.finalClassification       : live.finalClassification,
                finalClassificationReason: isOverridden ? snap.finalClassificationReason : live.finalClassificationReason,
              };
            });
            await StudentSubmission.updateOne({ _id: sub._id }, { $set: { courseSnapshot: updatedSnapshot } });
          }
        } catch (err) {
          summary.warnings.push(`Failed to classify student ${member.userId}: ${err.message}`);
        }
      })
    );

    // Trim warnings to avoid huge response
    if (summary.warnings.length > 50) {
      const trimmed = summary.warnings.length - 50;
      summary.warnings = summary.warnings.slice(0, 50);
      summary.warnings.push(`…and ${trimmed} more warnings.`);
    }

    return res.json(summary);
  } catch (err) {
    console.error('[admin/cohorts/cycles/reclassify POST]', err);
    return res.status(500).json({ error: 'Failed to reclassify cohort.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/courses/sections?subject=&course=&termCode=
// Fetch available sections for a course in a given term (admin-only).
// Used by the admin section preferences editor.
// ---------------------------------------------------------------------------
router.get('/courses/sections', async (req, res) => {
  try {
    const subject  = String(req.query.subject  ?? '').trim().toUpperCase();
    const course   = String(req.query.course   ?? '').trim().toUpperCase();
    const termCode = String(req.query.termCode ?? '').trim();
    if (!subject || !course || !termCode) {
      return res.status(400).json({ error: 'subject, course, and termCode are required.' });
    }
    const sections = await getCourseSections(subject, course, termCode);
    const instructorNames = [...new Set(sections.flatMap((s) => s.instructors ?? []))];
    const gradeStats = getCourseGradeStats(subject, course, instructorNames);
    // Best-effort: attach each instructor's syllabus PDF link (viewed term, last-taught term, or older).
    await attachSyllabusLinks(subject, course, termCode, sections, gradeStats);
    return res.json({ sections, termCode, gradeStats });
  } catch (err) {
    console.error('[admin/courses/sections GET]', err);
    return res.status(500).json({ error: 'Failed to fetch sections.' });
  }
});

module.exports = router;

