'use strict';
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const StudentSubmission = require('../../models/StudentSubmission');
const StudentCourseRequest = require('../../models/StudentCourseRequest');
const SectionPreference = require('../../models/SectionPreference');
const DegreePlanSelection = require('../../models/DegreePlanSelection');
const StudentAcademicProfile = require('../../models/StudentAcademicProfile');
const CohortMember = require('../../models/CohortMember');
const SchedulingCycle = require('../../models/SchedulingCycle');
const { getActiveSchedulingCycleForCohort } = require('../../lib/submissionHelpers');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/admin/cohorts/:cohortId/submissions[?cycleId=xxx]
// Returns submission status + course details for every active member.
// Defaults to the active scheduling cycle if cycleId is not provided.
// ---------------------------------------------------------------------------
router.get('/cohorts/:cohortId/submissions', requireAdmin, async (req, res) => {
  try {
    const { cohortId } = req.params;
    const { cycleId: queryCycleId } = req.query;

    // Resolve which cycle to use
    let cycle = null;
    if (queryCycleId) {
      cycle = await SchedulingCycle.findOne({ _id: queryCycleId, cohortId }).lean();
      if (!cycle) return res.status(404).json({ error: 'Cycle not found for this cohort.' });
    } else {
      cycle = await getActiveSchedulingCycleForCohort(cohortId);
    }

    const cycleFilter = cycle
      ? { schedulingCycleId: cycle._id }
      : { schedulingCycleId: { $exists: false } };

    const members = await CohortMember.find({ cohortId, status: 'active' })
      .populate('userId', 'name email')
      .lean();

    const userIds = members.map((m) => m.userId?._id).filter(Boolean);

    const [submissions, selections, allRequests, academicProfiles] = await Promise.all([
      StudentSubmission.find({ cohortId, userId: { $in: userIds }, ...cycleFilter }).lean(),
      DegreePlanSelection.find({ cohortId, userId: { $in: userIds } }).lean(),
      StudentCourseRequest.find({ cohortId, userId: { $in: userIds }, ...cycleFilter }).lean(),
      StudentAcademicProfile.find({ cohortId, userId: { $in: userIds } }, { userId: 1, primaryMajor: 1 }).lean(),
    ]);

    const requestIds = allRequests.map((r) => r._id);
    const allPrefs = await SectionPreference.find({ courseRequestId: { $in: requestIds } }).lean();

    const subMap = {};
    for (const s of submissions) subMap[s.userId.toString()] = s;
    const selMap = {};
    for (const s of selections) selMap[s.userId.toString()] = s;
    const profileMap = {};
    for (const p of academicProfiles) profileMap[p.userId.toString()] = p;
    const reqMap = {};
    for (const r of allRequests) {
      const key = r.userId.toString();
      if (!reqMap[key]) reqMap[key] = [];
      reqMap[key].push(r);
    }
    const prefMap = {};
    for (const p of allPrefs) {
      const key = p.courseRequestId.toString();
      if (!prefMap[key]) prefMap[key] = [];
      prefMap[key].push(p);
    }

    const result = members
      .map((m) => {
        const uid = m.userId?._id?.toString();
        if (!uid) return null;

        const submission = subMap[uid];
        const selection = selMap[uid];
        const profile = profileMap[uid];

        // Use frozen snapshot for submitted students (if available); fall back to live
        let requests;
        const useSnapshot =
          submission &&
          submission.status === 'submitted' &&
          Array.isArray(submission.courseSnapshot) &&
          submission.courseSnapshot.length > 0;

        if (useSnapshot) {
          requests = submission.courseSnapshot.map((snap) => ({
            code: snap.code,
            title: snap.title,
            creditHours: snap.creditHours ?? null,
            systemClassification: snap.systemClassification,
            finalClassification: snap.finalClassification,
            classificationReason: snap.classificationReason,
            preferredSections: (snap.preferredSections ?? []).map((p) => ({
              crn: p.crn,
              section: p.section,
              instructorLabel: p.instructorLabel,
            })),
          }));
        } else {
          requests = (reqMap[uid] ?? []).map((r) => ({
            code: r.code,
            title: r.title,
            creditHours: r.creditHours ?? null,
            systemClassification: r.systemClassification,
            finalClassification: r.finalClassification,
            classificationReason: r.classificationReason,
            preferredSections: (prefMap[r._id.toString()] ?? []).map((p) => ({
              crn: p.crn,
              section: p.section,
              instructorLabel: p.instructorLabel,
            })),
          }));
        }

        return {
          student: { id: uid, name: m.userId?.name, email: m.userId?.email },
          submission: submission
            ? {
                status: submission.status,
                submittedAt: submission.submittedAt,
                lastEditedAt: submission.lastEditedAt,
                draftUpdatedAfterSubmit: submission.draftUpdatedAfterSubmit ?? false,
                snapshotVersion: submission.snapshotVersion ?? 0,
                lastSubmittedAt: submission.lastSubmittedAt ?? null,
              }
            : null,
          degreePlanSelection: (() => {
            const src = (useSnapshot && submission.degreePlanSnapshot) ? submission.degreePlanSnapshot : selection;
            return src ? { planId: src.planId ?? null, planTitle: src.planTitle ?? null, catalog: src.catalog ?? null } : null;
          })(),
          primaryMajor: profile?.primaryMajor?.title ?? null,
          courseCount: requests.length,
          preferredSectionCount: requests.reduce((n, r) => n + r.preferredSections.length, 0),
          courses: requests,
        };
      })
      .filter(Boolean);

    return res.json({
      cycle: cycle
        ? { id: cycle._id, name: cycle.name, term: cycle.term, termCode: cycle.termCode, status: cycle.status }
        : null,
      submissions: result,
    });
  } catch (err) {
    console.error('[admin/cohorts/submissions]', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
