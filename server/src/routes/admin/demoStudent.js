'use strict';
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const User = require('../../models/User');
const Cohort = require('../../models/Cohort');
const SchedulingCycle = require('../../models/SchedulingCycle');
const CohortMember = require('../../models/CohortMember');
const StudentCourseRequest = require('../../models/StudentCourseRequest');
const StudentSubmission = require('../../models/StudentSubmission');
const SectionPreference = require('../../models/SectionPreference');
const StudentAcademicProfile = require('../../models/StudentAcademicProfile');
const DegreePlanSelection = require('../../models/DegreePlanSelection');
const StudentSemesterPlan = require('../../models/StudentSemesterPlan');
const StudentPlannedCourse = require('../../models/StudentPlannedCourse');

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function demoEmail(adminId) {
  return `demo+${adminId}@zlp.local`;
}

async function findOrCreateDemoStudent(admin) {
  let demo = await User.findOne({ isDemoStudent: true, demoForAdmin: admin._id }).lean();
  if (!demo) {
    demo = await User.create({
      email:         demoEmail(admin._id),
      name:          `${admin.name} (Demo Student)`,
      role:          'student',
      isDemoStudent: true,
      demoForAdmin:  admin._id,
      demoCreatedAt: new Date(),
      cohortId:      null,
    });
    demo = demo.toObject();
  }
  return demo;
}

function serializeDemo(u) {
  return {
    _id:           u._id,
    name:          u.name,
    email:         u.email,
    role:          u.role,
    cohortId:      u.cohortId ?? null,
    isDemoStudent: true,
  };
}

// ---------------------------------------------------------------------------
// Helper: delete all student-facing data for a demo student.
// Does NOT touch the User doc or CohortMember record.
// ---------------------------------------------------------------------------
async function resetDemoData(demoId) {
  const requests = await StudentCourseRequest.find({ userId: demoId }, '_id').lean();
  const requestIds = requests.map((r) => r._id);
  await Promise.all([
    StudentCourseRequest.deleteMany({ userId: demoId }),
    StudentSubmission.deleteMany({ userId: demoId }),
    SectionPreference.deleteMany({ courseRequestId: { $in: requestIds } }),
    StudentAcademicProfile.deleteMany({ userId: demoId }),
    DegreePlanSelection.deleteMany({ userId: demoId }),
    StudentSemesterPlan.deleteMany({ userId: demoId }),
    StudentPlannedCourse.deleteMany({ userId: demoId }),
  ]);
}

// ---------------------------------------------------------------------------
// POST /api/admin/demo-student/session/start
//
// Full demo-session initializer. Called every time an admin enters Demo
// Student View. Idempotently creates the hidden demo cohort, an open demo
// scheduling cycle, and the admin's personal demo student, then resets all
// demo student data so the session starts clean.
// ---------------------------------------------------------------------------
router.post('/demo-student/session/start', requireAdmin, async (req, res) => {
  try {
    // 1. Find or create the single global hidden system demo cohort.
    //    Its catalogYear always mirrors the most recently added real cohort's
    //    catalogYear, so major selection in Demo Student View filters to one
    //    catalog instead of showing every catalog year's programs mixed together.
    const latestRealCohort = await Cohort.findOne({
      isSystemDemo: { $ne: true },
      archivedAt:   { $exists: false },
      catalogYear:  { $nin: [null, ''] },
    }).sort({ createdAt: -1 }).lean();
    const mirrorCatalogYear = latestRealCohort?.catalogYear ?? null;

    let demoCohort = await Cohort.findOne({ isSystemDemo: true }).lean();
    if (!demoCohort) {
      demoCohort = (await Cohort.create({
        name: 'System Demo Cohort',
        isSystemDemo: true,
        hidden: true,
        joinCodeEnabled: false,
        createdBy: req.user._id,
        catalogYear: mirrorCatalogYear,
      })).toObject();
    } else if (demoCohort.catalogYear !== mirrorCatalogYear) {
      demoCohort = await Cohort.findByIdAndUpdate(
        demoCohort._id,
        { catalogYear: mirrorCatalogYear },
        { new: true, lean: true }
      );
    }

    // 2. Determine the best real cycle to mirror for the demo experience.
    //    Pick the most recently updated non-demo cycle that is open or activeForStudents,
    //    has a valid termCode, and is not archived.
    const FALLBACK_TERM      = 'Demo Cycle';
    const FALLBACK_TERM_CODE = '000000';

    const latestRealCycle = await SchedulingCycle.findOne({
      isSystemDemo: { $ne: true },
      archived:     { $ne: true },
      $or: [{ status: 'open' }, { activeForStudents: true }],
      termCode:     { $exists: true, $ne: '' },
    }).sort({ updatedAt: -1 }).lean();

    // Fields to mirror from the real cycle (or fall back to defaults).
    const mirrorTerm     = latestRealCycle?.term     ?? FALLBACK_TERM;
    const mirrorTermCode = latestRealCycle?.termCode ?? FALLBACK_TERM_CODE;
    const mirrorName     = latestRealCycle?.name
      ? `Demo — ${latestRealCycle.name}`
      : 'Demo Cycle';
    const cycleWarning = latestRealCycle
      ? null
      : 'No active real cycle found, using fallback demo cycle.';

    // 3. Find or create an open demo scheduling cycle for that cohort.
    //    Always sync term/termCode to the latest real cycle so the demo
    //    dashboard reflects the current active cycle.
    let demoCycle = await SchedulingCycle.findOne({
      cohortId:     demoCohort._id,
      isSystemDemo: true,
      archived:     { $ne: true },
    }).lean();

    if (!demoCycle) {
      demoCycle = (await SchedulingCycle.create({
        cohortId:          demoCohort._id,
        name:              mirrorName,
        term:              mirrorTerm,
        termCode:          mirrorTermCode,
        status:            'open',
        archived:          false,
        activeForStudents: true,
        isSystemDemo:      true,
        submissionDeadline: new Date('2099-12-31T23:59:59Z'),
        createdBy:         req.user._id,
      })).toObject();
    } else {
      // Always update to mirror the latest real cycle (and ensure open/active).
      demoCycle = await SchedulingCycle.findByIdAndUpdate(
        demoCycle._id,
        {
          name:              mirrorName,
          term:              mirrorTerm,
          termCode:          mirrorTermCode,
          status:            'open',
          activeForStudents: true,
        },
        { new: true, lean: true }
      );
    }

    // 4. Find or create this admin's personal demo student.
    let demoStudent = await User.findOne({ isDemoStudent: true, demoForAdmin: req.user._id }).lean();
    if (!demoStudent) {
      demoStudent = (await User.create({
        email:         demoEmail(req.user._id),
        name:          `${req.user.name} (Demo Student)`,
        role:          'student',
        isDemoStudent: true,
        demoForAdmin:  req.user._id,
        demoCreatedAt: new Date(),
        cohortId:      demoCohort._id,
      })).toObject();
    } else if (!demoStudent.cohortId || String(demoStudent.cohortId) !== String(demoCohort._id)) {
      demoStudent = await User.findByIdAndUpdate(
        demoStudent._id,
        { cohortId: demoCohort._id },
        { new: true, lean: true }
      );
    }

    // 4. Ensure an active CohortMember record links demo student → demo cohort.
    const existingMember = await CohortMember.findOne({
      userId:   demoStudent._id,
      cohortId: demoCohort._id,
    });
    if (!existingMember) {
      await CohortMember.create({
        userId:    demoStudent._id,
        cohortId:  demoCohort._id,
        status:    'active',
        joinedVia: 'demo',
      });
    } else if (existingMember.status !== 'active') {
      await CohortMember.findByIdAndUpdate(existingMember._id, { status: 'active' });
    }

    // 5. Reset all demo student data so the session starts clean.
    await resetDemoData(demoStudent._id);

    return res.json({
      demoStudent: serializeDemo(demoStudent),
      demoCohort:  { _id: demoCohort._id, name: demoCohort.name },
      demoCycle:   { _id: demoCycle._id, name: demoCycle.name, term: demoCycle.term, termCode: demoCycle.termCode, status: demoCycle.status },
      ...(cycleWarning ? { warning: cycleWarning } : {}),
    });
  } catch (err) {
    console.error('[admin/demo-student session/start]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/demo-student
// Find or create the demo student for the logged-in admin.
// ---------------------------------------------------------------------------
router.get('/demo-student', requireAdmin, async (req, res) => {
  try {
    const demo = await findOrCreateDemoStudent(req.user);
    return res.json({ demoStudent: serializeDemo(demo) });
  } catch (err) {
    console.error('[admin/demo-student GET]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/demo-student/reset
// Clears all demo student data while keeping the user account itself.
// ---------------------------------------------------------------------------
router.post('/demo-student/reset', requireAdmin, async (req, res) => {
  try {
    const demo = await User.findOne({ isDemoStudent: true, demoForAdmin: req.user._id }).lean();
    if (!demo) return res.json({ reset: true, message: 'No demo student exists yet.' });

    await resetDemoData(demo._id);

    const updated = await User.findById(demo._id).lean();
    return res.json({ reset: true, demoStudent: serializeDemo(updated) });
  } catch (err) {
    console.error('[admin/demo-student reset]', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
