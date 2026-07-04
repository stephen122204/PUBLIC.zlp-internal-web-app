'use strict';
/**
 * Live section fetching from TAMU's course-search system, with an in-memory
 * TTL cache in front of it. The actual request/response handling is removed
 * in this public repo — see README for why. Everything that depends on this
 * module (course search, section pickers, the scheduling algorithm's live
 * input) still works structurally, it just has no live data to fetch.
 */

async function fetchSectionsForTerm() {
  throw new Error('Live section fetching is not included in this public version — see README.');
}

async function getCourseSections() {
  throw new Error('Live section fetching is not included in this public version — see README.');
}

/** Normally maps a raw Banner-shaped row into the app's clean section shape. */
function mapSectionRow(row) {
  return row;
}

module.exports = { fetchSectionsForTerm, getCourseSections, mapSectionRow };
