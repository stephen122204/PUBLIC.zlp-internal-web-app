'use strict';
const express = require('express');
const { resolveStudentContext } = require('../../middleware/auth');
const { getStudentActiveCohort } = require('../../lib/submissionHelpers');
const { validateProgramIds, hasDuplicateIds, MAX_MINORS, MAX_ADDITIONAL_MAJORS } = require('../../lib/academicPrograms');
const StudentAcademicProfile = require('../../models/StudentAcademicProfile');
const StudentSubmission = require('../../models/StudentSubmission');

const router = express.Router();

/**
 * Convert a semester term like "Fall 2023" to an academic year like "2023-2024".
 */
function termToCatalogYear(term) {
  if (!term) return null;
  const m = term.match(/\b(\d{4})\b/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const isFall = /fall/i.test(term);
  const startYear = isFall ? year : year - 1;
  return `${startYear}-${startYear + 1}`;
}

/**
 * If a stored program entry has a catalog-year suffix that doesn't match
 * targetCatalog, try to swap in the correct catalog year if that program exists.
 */
function normalizeProgramEntry(entry, targetCatalog, type) {
  if (!entry?.programId || !targetCatalog) return entry;
  const match = entry.programId.match(/^(catalog-major:[^:]+):(\d{4}-\d{4})$/);
  if (!match || match[2] === targetCatalog) return entry;
  const normalizedId = `${match[1]}:${targetCatalog}`;
  const { valid } = validateProgramIds([normalizedId], type);
  if (valid.length > 0) {
    const normalized = toEntry(valid[0]);
    // Preserve the student's track selection across catalog-year normalization.
    if (entry.selectedTrackId != null) normalized.selectedTrackId = entry.selectedTrackId;
    return normalized;
  }
  return entry;
}

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
    updatedAt: p.updatedAt,
  };
}

function toEntry(prog) {
  return {
    programId: prog.id,
    title: prog.title,
    catalog: prog.catalog ?? null,
    college: prog.college ?? null,
    department: prog.department ?? null,
    degreePlanId: prog.degreePlanId ?? null,
    hasDetailedPlan: prog.hasDetailedPlan ?? false,
  };
}

router.get('/', resolveStudentContext, async (req, res) => {
  try {
    const cohort = await getStudentActiveCohort(req.studentUser._id);
    if (!cohort) return res.json({ profile: null, cohortCatalogYear: null });
    const profile = await StudentAcademicProfile.findOne({
      userId: req.studentUser._id,
      cohortId: cohort._id,
    }).lean();

    let serialized = profile ? serializeProfile(profile) : null;

    // Overlay student draft if present — student sees their own pending selections
    // rather than the admin-set canonical values until they submit.
    if (serialized && profile.studentDraft) {
      serialized = {
        ...serialized,
        primaryMajor:     profile.studentDraft.primaryMajor     ?? null,
        additionalMajors: profile.studentDraft.additionalMajors ?? [],
        minors:           profile.studentDraft.minors           ?? [],
      };
    }

    // Normalize stored programIds to the student's effective catalog year so
    // the degree graph and picker stay in sync without requiring a re-selection.
    if (serialized) {
      const effectiveTerm = serialized.catalogYear || cohort.catalogYear || null;
      const targetCatalog = termToCatalogYear(effectiveTerm);
      if (targetCatalog) {
        if (serialized.primaryMajor) {
          serialized = { ...serialized, primaryMajor: normalizeProgramEntry(serialized.primaryMajor, targetCatalog, 'major') };
        }
        if (serialized.additionalMajors?.length) {
          serialized = { ...serialized, additionalMajors: serialized.additionalMajors.map((m) => normalizeProgramEntry(m, targetCatalog, 'major')) };
        }
      }
    }

    return res.json({
      profile: serialized,
      cohortCatalogYear: cohort.catalogYear ?? null,
      effectiveCatalogYear: serialized?.catalogYear || cohort.catalogYear || null,
      catalogYearSource:
        serialized?.catalogYear && serialized.catalogYear !== cohort.catalogYear
          ? 'student_override'
          : 'cohort_default',
    });
  } catch (err) {
    console.error('[student/academic-profile GET]', err);
    return res.status(500).json({ error: 'Failed to load academic profile.' });
  }
});

router.put('/', resolveStudentContext, async (req, res) => {
  try {
    const {
      primaryMajorId,
      primaryTrackId = null,
      additionalMajorIds = [],
      minorIds = [],
    } = req.body;

    const cohort = await getStudentActiveCohort(req.studentUser._id);
    if (!cohort) return res.status(400).json({ error: 'Not enrolled in any active cohort.' });

    // Preserve any per-student catalogYear override set by an admin.
    // Use null (not the cohort default) so the override field stays clean:
    // null means "inherit cohort default"; a non-null value is a genuine override.
    const existingProfile = await StudentAcademicProfile.findOne(
      { userId: req.studentUser._id, cohortId: cohort._id },
    ).lean();
    const resolvedCatalogYear = existingProfile?.catalogYear ?? null;

    // Enforce secondaryProgramEnabled gate — students cannot add additional majors
    // unless an admin has explicitly enabled it for their profile.
    if (additionalMajorIds.length > 0 && !existingProfile?.secondaryProgramEnabled) {
      return res.status(403).json({ error: 'Secondary program enrollment has not been enabled for your account. Please contact your advisor.' });
    }
    if (additionalMajorIds.length > MAX_ADDITIONAL_MAJORS) {
      return res.status(400).json({ error: `You can add at most ${MAX_ADDITIONAL_MAJORS} additional major.` });
    }
    // Primary and additional share one pool — the same major can't fill two slots.
    if (hasDuplicateIds([primaryMajorId, ...additionalMajorIds])) {
      return res.status(400).json({ error: 'The same major cannot be selected more than once.' });
    }

    let primaryMajor = null;
    if (primaryMajorId) {
      const { valid, invalid } = validateProgramIds([primaryMajorId], 'major');
      if (invalid.length > 0) {
        return res.status(400).json({ error: 'Unknown major program: ' + primaryMajorId });
      }
      primaryMajor = toEntry(valid[0]);
      // Track is a student choice (not part of the program definition); attach it here.
      primaryMajor.selectedTrackId = primaryTrackId ?? null;
    }

    const { valid: validAdditional, invalid: invalidAdditional } = validateProgramIds(additionalMajorIds, 'major');
    if (invalidAdditional.length > 0) {
      return res.status(400).json({ error: 'Unknown major(s): ' + invalidAdditional.join(', ') });
    }

    if (minorIds.length > MAX_MINORS) {
      return res.status(400).json({ error: `You can add at most ${MAX_MINORS} minors.` });
    }
    if (hasDuplicateIds(minorIds)) {
      return res.status(400).json({ error: 'The same minor cannot be selected more than once.' });
    }

    const { valid: validMinors, invalid: invalidMinors } = validateProgramIds(minorIds, 'minor');
    if (invalidMinors.length > 0) {
      return res.status(400).json({ error: 'Unknown minor(s): ' + invalidMinors.join(', ') });
    }

    const profile = await StudentAcademicProfile.findOneAndUpdate(
      { userId: req.studentUser._id, cohortId: cohort._id },
      {
        // Write selections to studentDraft — admin view shows canonical only;
        // draft is promoted to canonical when the student submits course preferences.
        studentDraft: {
          primaryMajor,
          additionalMajors: validAdditional.map(toEntry),
          minors: validMinors.map(toEntry),
        },
      },
      { new: true, upsert: true }
    ).lean();

    // Academic profile change invalidates existing classifications — mark stale
    // so the student must re-run classification before submitting.
    await StudentSubmission.updateMany(
      { userId: req.studentUser._id, cohortId: cohort._id, status: { $ne: 'locked' } },
      { $set: { classificationStale: true } }
    );

    // Return the effective profile (draft values) so the student UI stays accurate
    const effectiveProfile = {
      ...serializeProfile(profile),
      primaryMajor,
      additionalMajors: validAdditional.map(toEntry),
      minors: validMinors.map(toEntry),
    };

    return res.json({
      profile: effectiveProfile,
      cohortCatalogYear: cohort.catalogYear ?? null,
    });
  } catch (err) {
    console.error('[student/academic-profile PUT]', err);
    return res.status(500).json({ error: 'Failed to save academic profile.' });
  }
});

module.exports = router;
