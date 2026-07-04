'use strict';
const express = require('express');
const mongoose = require('mongoose');
const { requireDeveloper } = require('../../middleware/auth');
const { getActiveSchedulingCycleForCohort, canEditSubmission } = require('../../lib/submissionHelpers');
const { listDegreePlans } = require('../../lib/degreePlanData');
const { validateProgramIds } = require('../../lib/academicPrograms');
const User = require('../../models/User');
const Cohort = require('../../models/Cohort');
const CohortMember = require('../../models/CohortMember');
const SchedulingCycle = require('../../models/SchedulingCycle');
const StudentCourseRequest = require('../../models/StudentCourseRequest');
const SectionPreference = require('../../models/SectionPreference');
const StudentSubmission = require('../../models/StudentSubmission');
const DegreePlanSelection = require('../../models/DegreePlanSelection');
const StudentAcademicProfile = require('../../models/StudentAcademicProfile');

const router = express.Router();

// All routes require developer role
router.use(requireDeveloper);

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
    map[key].push({
      crn: p.crn,
      section: p.section,
      instructorLabel: p.instructorLabel,
      meetings: p.meetings,
    });
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
    systemClassification: r.systemClassification,
    finalClassification: r.finalClassification,
    classificationReason: r.classificationReason,
    preferredSections: map[r._id.toString()] ?? [],
  }));
}

// ---------------------------------------------------------------------------
// GET /api/developer/cohorts
// List all cohorts (including archived) for the developer dropdown
// ---------------------------------------------------------------------------
router.get('/cohorts', async (req, res) => {
  try {
    const cohorts = await Cohort.find({}).sort({ createdAt: -1 }).lean();
    return res.json({
      cohorts: cohorts.map((c) => ({
        id: c._id,
        name: c.name,
        term: c.term ?? null,
        active: c.active,
        archivedAt: c.archivedAt ?? null,
      })),
    });
  } catch (err) {
    console.error('[developer/cohorts GET]', err);
    return res.status(500).json({ error: 'Failed to load cohorts.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/developer/cohorts/:cohortId/students
// List students in a cohort with membership and submission status
// ---------------------------------------------------------------------------
router.get('/cohorts/:cohortId/students', async (req, res) => {
  try {
    const { cohortId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(cohortId)) {
      return res.status(400).json({ error: 'Invalid cohortId.' });
    }

    const cohort = await Cohort.findById(cohortId).lean();
    if (!cohort) return res.status(404).json({ error: 'Cohort not found.' });

    const members = await CohortMember.find({ cohortId, status: 'active' }).lean();
    if (members.length === 0) return res.json({ students: [] });

    const userIds = members.map((m) => m.userId);
    const [users, activeCycle] = await Promise.all([
      User.find({ _id: { $in: userIds } }).lean(),
      getActiveSchedulingCycleForCohort(cohortId),
    ]);

    const userMap = {};
    for (const u of users) userMap[u._id.toString()] = u;

    let submissionMap = {};
    let selectionMap = {};
    if (activeCycle) {
      const [submissions, selections] = await Promise.all([
        StudentSubmission.find({ cohortId, schedulingCycleId: activeCycle._id }).lean(),
        DegreePlanSelection.find({ cohortId, userId: { $in: userIds } }).lean(),
      ]);
      for (const s of submissions) submissionMap[s.userId.toString()] = s;
      for (const s of selections) selectionMap[s.userId.toString()] = s;
    }

    const students = members.map((m) => {
      const uid = m.userId.toString();
      const u = userMap[uid];
      const sub = submissionMap[uid];
      const sel = selectionMap[uid];
      return {
        id: uid,
        name: u?.name ?? '(unknown)',
        email: u?.email ?? '',
        joinedAt: m.joinedAt,
        degreePlanTitle: sel?.planTitle ?? null,
        submissionStatus: sub?.status ?? 'none',
        submittedAt: sub?.submittedAt ?? null,
      };
    });

    return res.json({ students });
  } catch (err) {
    console.error('[developer/cohorts/students GET]', err);
    return res.status(500).json({ error: 'Failed to load students.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/developer/students/:studentId/context
// Full context for a student: cohort, cycle, degree plan, courses, submission
// Query: cohortId (required), cycleId (optional)
// ---------------------------------------------------------------------------
router.get('/students/:studentId/context', async (req, res) => {
  try {
    const { studentId } = req.params;
    const { cohortId, cycleId } = req.query;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({ error: 'Invalid studentId.' });
    }
    if (!cohortId || !mongoose.Types.ObjectId.isValid(cohortId)) {
      return res.status(400).json({ error: 'cohortId query parameter is required.' });
    }

    const [student, cohort, membership] = await Promise.all([
      User.findById(studentId).lean(),
      Cohort.findById(cohortId).lean(),
      CohortMember.findOne({ userId: studentId, cohortId, status: 'active' }).lean(),
    ]);

    if (!student) return res.status(404).json({ error: 'Student not found.' });
    if (!cohort) return res.status(404).json({ error: 'Cohort not found.' });
    if (!membership) return res.status(404).json({ error: 'Student is not an active member of this cohort.' });

    // Load all cycles for cohort
    const allCycles = await SchedulingCycle.find({ cohortId }).sort({ createdAt: -1 }).lean();

    // Determine which cycle to use
    let cycle = null;
    if (cycleId && mongoose.Types.ObjectId.isValid(cycleId)) {
      cycle = allCycles.find((c) => c._id.toString() === cycleId) ?? null;
    } else {
      // Default to active/open cycle
      cycle = allCycles.find((c) => c.activeForStudents && c.status === 'open') ?? allCycles[0] ?? null;
    }

    // Load degree plan selection + available plans
    const [degreePlanSel, degreePlansData] = await Promise.all([
      DegreePlanSelection.findOne({ userId: studentId, cohortId }).lean(),
      Promise.resolve(listDegreePlans()),
    ]);

    // Load course requests + submission for the selected cycle
    let courseRequests = [];
    let submission = null;
    if (cycle) {
      const [rawRequests, sub] = await Promise.all([
        StudentCourseRequest.find({
          userId: studentId,
          cohortId,
          schedulingCycleId: cycle._id,
        }).sort({ createdAt: 1 }).lean(),
        StudentSubmission.findOne({
          userId: studentId,
          cohortId,
          schedulingCycleId: cycle._id,
        }).lean(),
      ]);
      courseRequests = await attachSections(rawRequests);
      submission = sub
        ? { status: sub.status, submittedAt: sub.submittedAt, lastEditedAt: sub.lastEditedAt }
        : null;
    }

    return res.json({
      devPreview: true,
      student: { id: student._id, name: student.name, email: student.email, role: student.role },
      cohort: { id: cohort._id, name: cohort.name, term: cohort.term, active: cohort.active },
      allCycles: allCycles.map((c) => ({
        id: c._id,
        term: c.term,
        termCode: c.termCode,
        status: c.status,
        activeForStudents: c.activeForStudents,
        submissionDeadline: c.submissionDeadline,
      })),
      selectedCycleId: cycle?._id ?? null,
      canEdit: canEditSubmission(cycle),
      degreePlanSelection: degreePlanSel
        ? { planId: degreePlanSel.planId, planTitle: degreePlanSel.planTitle, catalog: degreePlanSel.catalog }
        : null,
      degreePlans: degreePlansData.plans,
      courseRequests,
      submission,
    });
  } catch (err) {
    console.error('[developer/students/context GET]', err);
    return res.status(500).json({ error: 'Failed to load student context.' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/developer/students/:studentId/degree-plan-selection
// Body: { cohortId, planId, planTitle?, catalog? }
// ---------------------------------------------------------------------------
router.patch('/students/:studentId/degree-plan-selection', async (req, res) => {
  try {
    const { studentId } = req.params;
    const { cohortId, planId, planTitle, catalog } = req.body;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({ error: 'Invalid studentId.' });
    }
    if (!cohortId || !mongoose.Types.ObjectId.isValid(cohortId)) {
      return res.status(400).json({ error: 'cohortId is required.' });
    }
    if (!planId) return res.status(400).json({ error: 'planId is required.' });

    const selection = await DegreePlanSelection.findOneAndUpdate(
      { userId: studentId, cohortId },
      { planId, planTitle: planTitle ?? planId, catalog: catalog ?? null },
      { new: true, upsert: true }
    ).lean();

    return res.json({
      degreePlanSelection: {
        planId: selection.planId,
        planTitle: selection.planTitle,
        catalog: selection.catalog,
      },
    });
  } catch (err) {
    console.error('[developer/students/degree-plan-selection PATCH]', err);
    return res.status(500).json({ error: 'Failed to update degree plan selection.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/developer/students/:studentId/course-requests
// Body: { cohortId, cycleId, subject, number, title?, college?, campus? }
// Developer bypasses submission deadline check
// ---------------------------------------------------------------------------
router.post('/students/:studentId/course-requests', async (req, res) => {
  try {
    const { studentId } = req.params;
    const { cohortId, cycleId, subject, number, title, college, campus } = req.body;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({ error: 'Invalid studentId.' });
    }
    if (!cohortId || !mongoose.Types.ObjectId.isValid(cohortId)) {
      return res.status(400).json({ error: 'cohortId is required.' });
    }
    if (!cycleId || !mongoose.Types.ObjectId.isValid(cycleId)) {
      return res.status(400).json({ error: 'cycleId is required.' });
    }
    if (!subject || !number) {
      return res.status(400).json({ error: 'subject and number are required.' });
    }

    const cycle = await SchedulingCycle.findById(cycleId).lean();
    if (!cycle) return res.status(404).json({ error: 'Scheduling cycle not found.' });

    const code = `${String(subject).trim().toUpperCase()} ${String(number).trim()}`;

    const request = await StudentCourseRequest.findOneAndUpdate(
      { userId: studentId, cohortId, schedulingCycleId: cycleId, code },
      {
        subject: String(subject).trim().toUpperCase(),
        number: String(number).trim(),
        title: title ?? '',
        college: college ?? '',
        campus: campus ?? 'college-station',
        termCode: cycle.termCode,
        schedulingCycleId: cycleId,
        systemClassification: 'unclassified',
        finalClassification: 'unclassified',
        classificationReason: 'Classification pending.',
      },
      { new: true, upsert: true }
    ).lean();

    // Ensure a draft submission record exists
    await StudentSubmission.findOneAndUpdate(
      { userId: studentId, cohortId, schedulingCycleId: cycleId },
      { $setOnInsert: { status: 'draft' }, lastEditedAt: new Date() },
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
    console.error('[developer/students/course-requests POST]', err);
    return res.status(500).json({ error: 'Failed to add course request.' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/developer/students/:studentId/course-requests/:requestId
// Body: { cohortId, cycleId }
// Developer bypasses submission deadline check
// ---------------------------------------------------------------------------
router.delete('/students/:studentId/course-requests/:requestId', async (req, res) => {
  try {
    const { studentId, requestId } = req.params;
    const { cohortId, cycleId } = req.body;

    if (!mongoose.Types.ObjectId.isValid(studentId) || !mongoose.Types.ObjectId.isValid(requestId)) {
      return res.status(400).json({ error: 'Invalid id.' });
    }
    if (!cohortId || !mongoose.Types.ObjectId.isValid(cohortId)) {
      return res.status(400).json({ error: 'cohortId is required.' });
    }
    if (!cycleId || !mongoose.Types.ObjectId.isValid(cycleId)) {
      return res.status(400).json({ error: 'cycleId is required.' });
    }

    const request = await StudentCourseRequest.findOne({
      _id: requestId,
      userId: studentId,
      cohortId,
      schedulingCycleId: cycleId,
    });
    if (!request) return res.status(404).json({ error: 'Course request not found.' });

    await SectionPreference.deleteMany({ courseRequestId: request._id });
    await request.deleteOne();

    await StudentSubmission.updateOne(
      { userId: studentId, cohortId, schedulingCycleId: cycleId },
      { lastEditedAt: new Date() }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error('[developer/students/course-requests DELETE]', err);
    return res.status(500).json({ error: 'Failed to delete course request.' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/developer/students/:studentId/course-requests/:requestId/section-preferences
// Body: { cohortId, cycleId, sections: [{ crn, section, instructorLabel, meetings }] }
// Developer bypasses submission deadline check
// ---------------------------------------------------------------------------
router.put('/students/:studentId/course-requests/:requestId/section-preferences', async (req, res) => {
  try {
    const { studentId, requestId } = req.params;
    const { cohortId, cycleId, sections = [] } = req.body;

    if (!mongoose.Types.ObjectId.isValid(studentId) || !mongoose.Types.ObjectId.isValid(requestId)) {
      return res.status(400).json({ error: 'Invalid id.' });
    }
    if (!cohortId || !mongoose.Types.ObjectId.isValid(cohortId)) {
      return res.status(400).json({ error: 'cohortId is required.' });
    }
    if (!cycleId || !mongoose.Types.ObjectId.isValid(cycleId)) {
      return res.status(400).json({ error: 'cycleId is required.' });
    }

    const cycle = await SchedulingCycle.findById(cycleId).lean();
    if (!cycle) return res.status(404).json({ error: 'Scheduling cycle not found.' });

    const request = await StudentCourseRequest.findOne({
      _id: requestId,
      userId: studentId,
      cohortId,
      schedulingCycleId: cycleId,
    });
    if (!request) return res.status(404).json({ error: 'Course request not found.' });

    await SectionPreference.deleteMany({ courseRequestId: request._id });
    if (sections.length > 0) {
      const docs = sections.map((s) => ({
        courseRequestId: request._id,
        userId: studentId,
        cohortId,
        schedulingCycleId: cycleId,
        termCode: cycle.termCode,
        crn: s.crn,
        section: s.section ?? '',
        instructorLabel: s.instructorLabel ?? '',
        meetings: s.meetings ?? [],
      }));
      await SectionPreference.insertMany(docs, { ordered: false });
    }

    await StudentSubmission.updateOne(
      { userId: studentId, cohortId, schedulingCycleId: cycleId },
      { lastEditedAt: new Date() }
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
    console.error('[developer/students/section-preferences PUT]', err);
    return res.status(500).json({ error: 'Failed to save section preferences.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/developer/students/:studentId/submission
// Body: { cohortId, cycleId, force? }
// Developer can submit/resubmit bypassing deadline
// ---------------------------------------------------------------------------
router.post('/students/:studentId/submission', async (req, res) => {
  try {
    const { studentId } = req.params;
    const { cohortId, cycleId, force = false } = req.body;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({ error: 'Invalid studentId.' });
    }
    if (!cohortId || !mongoose.Types.ObjectId.isValid(cohortId)) {
      return res.status(400).json({ error: 'cohortId is required.' });
    }
    if (!cycleId || !mongoose.Types.ObjectId.isValid(cycleId)) {
      return res.status(400).json({ error: 'cycleId is required.' });
    }

    const [sel, courseCount, cycle] = await Promise.all([
      DegreePlanSelection.findOne({ userId: studentId, cohortId }).lean(),
      StudentCourseRequest.countDocuments({ userId: studentId, cohortId, schedulingCycleId: cycleId }),
      SchedulingCycle.findById(cycleId).lean(),
    ]);

    if (!cycle) return res.status(404).json({ error: 'Scheduling cycle not found.' });

    if (!force) {
      if (!sel) return res.status(400).json({ error: 'Student has not selected a degree plan.' });
      if (courseCount === 0) return res.status(400).json({ error: 'Student has no course requests.' });
    }

    const now = new Date();
    const submission = await StudentSubmission.findOneAndUpdate(
      { userId: studentId, cohortId, schedulingCycleId: cycleId },
      { status: 'submitted', submittedAt: now, lastEditedAt: now },
      { new: true, upsert: true }
    ).lean();

    return res.json({
      success: true,
      submission: {
        status: submission.status,
        submittedAt: submission.submittedAt,
        lastEditedAt: submission.lastEditedAt,
      },
    });
  } catch (err) {
    console.error('[developer/students/submission POST]', err);
    return res.status(500).json({ error: 'Failed to submit.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/developer/cohorts/:cohortId/dummy-students
// Body: { name }
// Create a dummy student attached to a cohort (no Google OAuth required)
// ---------------------------------------------------------------------------
router.post('/cohorts/:cohortId/dummy-students', async (req, res) => {
  try {
    const { cohortId } = req.params;
    const { name, primaryMajorId, additionalMajorIds = [], minorIds = [], catalogYear } = req.body;

    if (!mongoose.Types.ObjectId.isValid(cohortId)) {
      return res.status(400).json({ error: 'Invalid cohortId.' });
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required.' });
    }

    const cohort = await Cohort.findById(cohortId).lean();
    if (!cohort) return res.status(404).json({ error: 'Cohort not found.' });
    if (cohort.archivedAt) return res.status(400).json({ error: 'Cannot add dummy students to an archived cohort.' });

    // Generate a unique dummy email
    const slug = String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'student';
    const rand = Math.random().toString(36).slice(2, 8);
    const email = `dummy+${slug}-${rand}@zlp.local`;

    const user = await User.create({
      name: String(name).trim(),
      email,
      role: 'student',
      cohortId,
      isDummy: true,
      dummyCreatedBy: req.user._id,
      dummyCreatedAt: new Date(),
    });

    const membership = await CohortMember.create({
      cohortId,
      userId: user._id,
      status: 'active',
      joinedAt: new Date(),
    });

    // Optionally create academic profile if plan provided
    if (primaryMajorId) {
      const { valid: validPrimary } = validateProgramIds([primaryMajorId], 'major');
      if (validPrimary.length > 0) {
        const primaryProg = validPrimary[0];
        const { valid: validAdditional } = validateProgramIds(additionalMajorIds, 'major');
        const { valid: validMinors } = validateProgramIds(minorIds, 'minor');
        const toEntry = (p) => ({
          programId: p.id, title: p.title, catalog: p.catalog ?? null,
          college: p.college ?? null, department: p.department ?? null,
          degreePlanId: p.degreePlanId ?? null, hasDetailedPlan: p.hasDetailedPlan ?? false,
        });
        await StudentAcademicProfile.findOneAndUpdate(
          { userId: user._id, cohortId },
          {
            catalogYear: catalogYear || null,
            primaryMajor: toEntry(primaryProg),
            additionalMajors: validAdditional.map(toEntry),
            minors: validMinors.map(toEntry),
            updatedBy: req.user._id,
          },
          { upsert: true }
        );
      }
    }

    return res.status(201).json({
      student: {
        id: user._id,
        name: user.name,
        email: user.email,
        isDummy: true,
        dummyCreatedAt: user.dummyCreatedAt,
      },
      membership: {
        id: membership._id,
        cohortId: membership.cohortId,
        status: membership.status,
        joinedAt: membership.joinedAt,
      },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'A dummy student with that name already exists in this cohort. Try a different name.' });
    }
    console.error('[developer/dummy-students POST]', err);
    return res.status(500).json({ error: 'Failed to create dummy student.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/developer/cohorts/:cohortId/dummy-students
// List dummy students in a cohort
// ---------------------------------------------------------------------------
router.get('/cohorts/:cohortId/dummy-students', async (req, res) => {
  try {
    const { cohortId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(cohortId)) {
      return res.status(400).json({ error: 'Invalid cohortId.' });
    }

    const members = await CohortMember.find({ cohortId, status: 'active' }).lean();
    const userIds = members.map((m) => m.userId);
    const users = await User.find({ _id: { $in: userIds }, isDummy: true }).lean();

    return res.json({
      dummyStudents: users.map((u) => ({
        id: u._id,
        name: u.name,
        email: u.email,
        isDummy: true,
        dummyCreatedAt: u.dummyCreatedAt,
      })),
    });
  } catch (err) {
    console.error('[developer/dummy-students GET]', err);
    return res.status(500).json({ error: 'Failed to load dummy students.' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/developer/dummy-students/:studentId
// Body: { name }
// Update dummy student name only
// ---------------------------------------------------------------------------
router.patch('/dummy-students/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    const { name } = req.body;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({ error: 'Invalid studentId.' });
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required.' });
    }

    const user = await User.findOne({ _id: studentId, isDummy: true });
    if (!user) return res.status(404).json({ error: 'Dummy student not found.' });

    user.name = String(name).trim();
    await user.save();

    return res.json({ id: user._id, name: user.name, email: user.email, isDummy: true });
  } catch (err) {
    console.error('[developer/dummy-students PATCH]', err);
    return res.status(500).json({ error: 'Failed to update dummy student.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/developer/dummy-students/:studentId/remove
// Soft-remove dummy student from cohort (marks membership removed)
// ---------------------------------------------------------------------------
router.post('/dummy-students/:studentId/remove', async (req, res) => {
  try {
    const { studentId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({ error: 'Invalid studentId.' });
    }

    const user = await User.findOne({ _id: studentId, isDummy: true }).lean();
    if (!user) return res.status(404).json({ error: 'Dummy student not found.' });

    await CohortMember.updateMany(
      { userId: studentId, status: 'active' },
      { status: 'removed', removedAt: new Date() }
    );

    await User.findByIdAndUpdate(studentId, { cohortId: null });

    return res.json({ success: true });
  } catch (err) {
    console.error('[developer/dummy-students/remove POST]', err);
    return res.status(500).json({ error: 'Failed to remove dummy student.' });
  }
});

module.exports = router;
