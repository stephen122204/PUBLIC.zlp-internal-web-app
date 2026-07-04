'use strict';
const CohortMember = require('../models/CohortMember');
const Cohort = require('../models/Cohort');
const SchedulingCycle = require('../models/SchedulingCycle');

/**
 * Returns the active Cohort for a student user, or null if not enrolled.
 */
async function getStudentActiveCohort(userId) {
  const membership = await CohortMember.findOne({ userId, status: 'active' });
  if (!membership) return null;
  return Cohort.findById(membership.cohortId);
}

/**
 * Returns the currently active/open SchedulingCycle for a cohort, or null.
 * Used for WRITE operations (submit, add/delete course requests).
 * Only returns a cycle when status === 'open' and it is not archived.
 */
async function getActiveSchedulingCycleForCohort(cohortId) {
  if (!cohortId) return null;
  return SchedulingCycle.findOne({
    cohortId,
    activeForStudents: true,
    status: 'open',
    archived: { $ne: true },
  }).lean();
}

/**
 * Returns the most recent relevant SchedulingCycle for a cohort — either
 * 'open' (active submission window) or 'closed' (submissions ended but still
 * shown to students as read-only history). Draft and archived cycles are
 * excluded. Used for READ/DISPLAY operations on the student dashboard.
 */
async function getCurrentCycleForCohort(cohortId) {
  if (!cohortId) return null;
  return SchedulingCycle.findOne({
    cohortId,
    status: { $in: ['open', 'closed'] },
    archived: { $ne: true },
  })
    .sort({ createdAt: -1 })
    .lean();
}

/**
 * Returns a user-facing error message explaining why the student cannot
 * submit to this cohort's cycle right now, or null if there is no specific
 * reason (e.g. simply no cycle exists).
 */
async function getCycleSubmissionError(cohortId) {
  if (!cohortId) return null;
  const latest = await SchedulingCycle.findOne({ cohortId }).sort({ createdAt: -1 }).lean();
  if (!latest) return null;
  if (latest.archived || latest.status === 'archived') {
    return 'This scheduling cycle is archived and cannot accept submissions.';
  }
  if (latest.status === 'closed') {
    return 'This scheduling cycle is closed. Submissions are no longer accepted.';
  }
  if (latest.status === 'draft') {
    return 'This scheduling cycle has not been opened yet.';
  }
  return null;
}

/**
 * Returns true if the student may still create/edit their submission.
 * Accepts a SchedulingCycle document (or plain object).
 */
function canEditSubmission(cycle) {
  if (!cycle) return false;
  if (cycle.archived) return false;
  if (cycle.status !== 'open') return false;
  if (!cycle.submissionDeadline) return true;
  return new Date() < new Date(cycle.submissionDeadline);
}

module.exports = {
  getStudentActiveCohort,
  getActiveSchedulingCycleForCohort,
  getCurrentCycleForCohort,
  getCycleSubmissionError,
  canEditSubmission,
};

