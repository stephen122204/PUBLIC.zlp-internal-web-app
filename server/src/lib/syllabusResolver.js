'use strict';
/**
 * Resolves a syllabus PDF link for a professor teaching a course, by trying
 * the current term, then their last-taught term, then walking backward a
 * bounded number of terms. Removed in this public repo — see README for why.
 */

async function resolveInstructorSyllabus() {
  return null;
}

/** No-op in this public version — leaves gradeStats unmodified. */
async function attachSyllabusLinks(subject, course, termCode, sections, gradeStats) {
  return gradeStats;
}

module.exports = {
  resolveInstructorSyllabus,
  attachSyllabusLinks,
};
