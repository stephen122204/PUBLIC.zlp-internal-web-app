'use strict';
/**
 * server/src/routes/admin/academicProfile.js
 *
 * GET  /api/admin/students/:studentId/academic-profile?cohortId=
 * PUT  /api/admin/students/:studentId/academic-profile
 *
 * Auth: requireAdmin (passes admin + developer)
 */
const express = require('express');
const mongoose = require('mongoose');
const { requireAdmin } = require('../../middleware/auth');
const { validateProgramIds } = require('../../lib/academicPrograms');
const StudentAcademicProfile = require('../../models/StudentAcademicProfile');
const StudentSubmission = require('../../models/StudentSubmission');
const Cohort = require('../../models/Cohort');

const router = express.Router();
router.use(requireAdmin);

// ---------------------------------------------------------------------------
// Serialize a profile document for API responses
// ---------------------------------------------------------------------------
function serializeProfile(p) {
  return {
    id: p._id,
    userId: p.userId,
    cohortId: p.cohortId,
    catalogYear: p.catalogYear ?? null,
    primaryMajor: p.primaryMajor ?? null,
    additionalMajors: p.additionalMajors ?? [],
    minors: p.minors ?? [],
    secondaryProgramEnabled: p.secondaryProgramEnabled ?? false,
    allowOverCreditSubmission: p.allowOverCreditSubmission ?? false,
    allowOverCreditSubmissionBy: p.allowOverCreditSubmissionBy ?? null,
    allowOverCreditSubmissionAt: p.allowOverCreditSubmissionAt ?? null,
    updatedAt: p.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Build a programEntry object from a validated program object
// ---------------------------------------------------------------------------
function toEntry(prog) {
  return {
    programId:       prog.id,
    title:           prog.title,
    catalog:         prog.catalog ?? null,
    college:         prog.college ?? null,
    department:      prog.department ?? null,
    degreePlanId:    prog.degreePlanId ?? null,
    hasDetailedPlan: prog.hasDetailedPlan ?? false,
  };
}

// ---------------------------------------------------------------------------
// GET /api/admin/students/:studentId/academic-profile?cohortId=
// ---------------------------------------------------------------------------
router.get('/students/:studentId/academic-profile', async (req, res) => {
  try {
    const { studentId } = req.params;
    const { cohortId } = req.query;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({ error: 'Invalid studentId.' });
    }
    if (!cohortId || !mongoose.Types.ObjectId.isValid(cohortId)) {
      return res.status(400).json({ error: 'cohortId query param required.' });
    }

    const [profile, cohort] = await Promise.all([
      StudentAcademicProfile.findOne({ userId: studentId, cohortId }).lean(),
      Cohort.findById(cohortId).lean(),
    ]);
    const effectiveCatalogYear = profile?.catalogYear || cohort?.catalogYear || null;
    const catalogYearSource =
      profile?.catalogYear && profile.catalogYear !== cohort?.catalogYear
        ? 'student_override'
        : 'cohort_default';
    return res.json({
      profile: profile ? { ...serializeProfile(profile), effectiveCatalogYear, catalogYearSource } : null,
      cohortCatalogYear: cohort?.catalogYear ?? null,
      effectiveCatalogYear,
      catalogYearSource,
    });
  } catch (err) {
    console.error('[admin/academic-profile GET]', err);
    return res.status(500).json({ error: 'Failed to load academic profile.' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/admin/students/:studentId/academic-profile
// Body: { cohortId, catalogYear, primaryMajorId, primaryTrackId, additionalMajorIds, minorIds }
// ---------------------------------------------------------------------------
router.put('/students/:studentId/academic-profile', async (req, res) => {
  try {
    const { studentId } = req.params;
    const {
      cohortId,
      catalogYear,
      primaryMajorId,
      primaryTrackId,           // undefined = not sent (preserve existing); null = clear
      additionalMajorIds = [],
      minorIds = [],
      secondaryProgramEnabled,
      allowOverCreditSubmission,
    } = req.body;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({ error: 'Invalid studentId.' });
    }
    if (!cohortId || !mongoose.Types.ObjectId.isValid(cohortId)) {
      return res.status(400).json({ error: 'cohortId is required.' });
    }

    const [cohort, existingProfile] = await Promise.all([
      Cohort.findById(cohortId).lean(),
      StudentAcademicProfile.findOne({ userId: studentId, cohortId }).lean(),
    ]);
    if (!cohort) return res.status(404).json({ error: 'Cohort not found.' });

    // Validate primary major
    let primaryMajor = null;
    if (primaryMajorId) {
      const { valid, invalid } = validateProgramIds([primaryMajorId], 'major');
      if (invalid.length > 0) {
        return res.status(400).json({ error: `Unknown major program: ${primaryMajorId}` });
      }
      primaryMajor = toEntry(valid[0]);
      // Track is a student choice, not part of the program definition. Use the value sent;
      // when it isn't sent (e.g. a catalog-year or secondary-program save), preserve the
      // existing track for the same major; if the major changed, clear it.
      if (primaryTrackId !== undefined) {
        primaryMajor.selectedTrackId = primaryTrackId ?? null;
      } else if (existingProfile?.primaryMajor?.programId === primaryMajorId) {
        primaryMajor.selectedTrackId = existingProfile.primaryMajor.selectedTrackId ?? null;
      } else {
        primaryMajor.selectedTrackId = null;
      }
    }

    // Validate additional majors
    const { valid: validAdditional, invalid: invalidAdditional } = validateProgramIds(additionalMajorIds, 'major');
    if (invalidAdditional.length > 0) {
      return res.status(400).json({ error: `Unknown major program(s): ${invalidAdditional.join(', ')}` });
    }

    // Validate minors
    const { valid: validMinors, invalid: invalidMinors } = validateProgramIds(minorIds, 'minor');
    if (invalidMinors.length > 0) {
      return res.status(400).json({ error: `Unknown minor program(s): ${invalidMinors.join(', ')}` });
    }

    // Normalize catalog year:
    //   - undefined (not in body)  --> don't touch the stored override
    //   - empty / equals cohort default --> clear override (null = inherit cohort)
    //   - any other value            --> genuine per-student override
    let normalizedCatalogYear;
    if (catalogYear === undefined) {
      normalizedCatalogYear = undefined; // preserve existing value
    } else if (!catalogYear || catalogYear === cohort.catalogYear) {
      normalizedCatalogYear = null; // clear override — student will inherit cohort default
    } else {
      normalizedCatalogYear = catalogYear; // student-specific override
    }

    // Build update object; only set secondaryProgramEnabled when explicitly sent
    const profileUpdate = {
      ...(normalizedCatalogYear !== undefined && { catalogYear: normalizedCatalogYear }),
      primaryMajor,
      additionalMajors: validAdditional.map(toEntry),
      minors: validMinors.map(toEntry),
      updatedBy: req.user._id,
    };
    if (secondaryProgramEnabled !== undefined) {
      profileUpdate.secondaryProgramEnabled = Boolean(secondaryProgramEnabled);
    }
    if (allowOverCreditSubmission !== undefined) {
      profileUpdate.allowOverCreditSubmission = Boolean(allowOverCreditSubmission);
      if (Boolean(allowOverCreditSubmission)) {
        profileUpdate.allowOverCreditSubmissionBy = req.user._id;
        profileUpdate.allowOverCreditSubmissionAt = new Date();
      } else {
        profileUpdate.allowOverCreditSubmissionBy = null;
        profileUpdate.allowOverCreditSubmissionAt = null;
      }
    }

    // When admin changes the major/minor, clear the student's pending draft so
    // the student immediately sees the admin's new canonical selection.
    const existingPrimaryId       = existingProfile?.primaryMajor?.programId ?? null;
    const existingAdditionalIds   = (existingProfile?.additionalMajors ?? []).map((e) => e.programId).sort().join('|');
    const existingMinorIds        = (existingProfile?.minors ?? []).map((e) => e.programId).sort().join('|');
    const incomingPrimaryId       = primaryMajor?.programId ?? null;
    const incomingAdditionalIds   = (validAdditional ?? []).map((e) => e.programId).sort().join('|');
    const incomingMinorIds        = (validMinors ?? []).map((e) => e.programId).sort().join('|');
    const majorMinorChanged =
      incomingPrimaryId !== existingPrimaryId ||
      incomingAdditionalIds !== existingAdditionalIds ||
      incomingMinorIds !== existingMinorIds;

    const updateOp = { $set: profileUpdate };
    if (majorMinorChanged) updateOp.$unset = { studentDraft: 1 };

    const profile = await StudentAcademicProfile.findOneAndUpdate(
      { userId: studentId, cohortId },
      updateOp,
      { new: true, upsert: true }
    ).lean();

    // Mark classification stale when the effective catalog year changed
    const oldCatalogYear = existingProfile?.catalogYear ?? null;
    const newCatalogYear = profile?.catalogYear ?? null;
    if (oldCatalogYear !== newCatalogYear) {
      await StudentSubmission.updateMany(
        { userId: studentId, cohortId, status: { $ne: 'locked' } },
        { $set: { classificationStale: true } }
      );
    }

    const effectiveCatalogYear = profile?.catalogYear || cohort.catalogYear || null;
    const catalogYearSource =
      profile?.catalogYear && profile.catalogYear !== cohort.catalogYear
        ? 'student_override'
        : 'cohort_default';
    return res.json({
      profile: { ...serializeProfile(profile), effectiveCatalogYear, catalogYearSource },
      cohortCatalogYear: cohort.catalogYear ?? null,
      effectiveCatalogYear,
      catalogYearSource,
    });
  } catch (err) {
    console.error('[admin/academic-profile PUT]', err);
    return res.status(500).json({ error: 'Failed to save academic profile.' });
  }
});

module.exports = router;

