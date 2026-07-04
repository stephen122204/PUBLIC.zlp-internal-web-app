'use strict';
/**
 * Course-search and course-history logic backed by the prebuilt
 * server/data/catalog-index.json index file.
 *
 * Ported from reference/tamu-course-offering-history/lib/vercel-api.mjs.
 * Adapted to CommonJS; no external dependencies.
 */

const path = require('path');
const fs = require('fs');

const CATALOG_INDEX_PATH = path.join(__dirname, '../../data/catalog-index.json');
const COURSE_HOURS_PATH  = path.join(__dirname, '../../data/course-hours.json');

/** @type {Array<object>|null} */
let catalogIndexCache = null;
/** @type {Object|null} */
let courseHoursCache = null;

function loadCatalogIndex() {
  if (catalogIndexCache) return catalogIndexCache;
  const raw = fs.readFileSync(CATALOG_INDEX_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  catalogIndexCache = Array.isArray(parsed?.entries) ? parsed.entries : [];
  return catalogIndexCache;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseCourseCode(query) {
  const match = query
    .trim()
    .toUpperCase()
    .match(/^([A-Z]{2,5})[\s-]*([0-9]{3}[A-Z]?)$/);
  if (!match) return null;
  return { subject: match[1], courseNumber: match[2] };
}

function normalizeQueryTokens(query) {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function campusMatches(entryCampus, requestedCampus) {
  if (!requestedCampus || requestedCampus === 'all') return true;
  return entryCampus === requestedCampus;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

function loadCourseHours() {
  if (courseHoursCache) return courseHoursCache;
  try {
    const raw = fs.readFileSync(COURSE_HOURS_PATH, 'utf8');
    courseHoursCache = JSON.parse(raw)?.hours ?? {};
  } catch {
    courseHoursCache = {}; // file not yet built — degrade gracefully
  }
  return courseHoursCache;
}

/**
 * Search the catalog index for courses matching `query`.
 *
 * @param {string} query     - e.g. "CSCE 121" or "machine learning"
 * @param {object} [options]
 * @param {string} [options.campus]  - default "college-station"
 * @param {number} [options.limit]   - default 50
 * @returns {Array<object>}
 */
function searchCourses(query, options = {}) {
  const { campus = 'college-station', limit = 50 } = options;
  const index = loadCatalogIndex();

  const q = String(query ?? '').trim();
  if (!q) return [];

  const exactCourse = parseCourseCode(q);
  const tokens = exactCourse ? [] : normalizeQueryTokens(q);

  const filtered = index.filter((entry) => {
    if (!campusMatches(entry.campus, campus)) return false;
    if (exactCourse) {
      return (
        entry.subject === exactCourse.subject &&
        String(entry.courseNumber) === exactCourse.courseNumber
      );
    }
    const haystack = [
      entry.subject,
      String(entry.courseNumber),
      entry.title,
      entry.college ?? '',
    ]
      .join(' ')
      .toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });

  const grouped = new Map();

  for (const entry of filtered) {
    const key = `${entry.subject}-${entry.courseNumber}`;
    const cur = grouped.get(key);
    if (!cur) {
      grouped.set(key, {
        subject: entry.subject,
        courseNumber: String(entry.courseNumber),
        title: entry.title,
        latestTermCode: String(entry.termCode),
        latestTermDescription: entry.termDescription,
        offeringCount: 1,
        sectionsCount: entry.sectionsCount ?? 0,
        colleges: entry.college ? [entry.college] : [],
        exactMatch: !!exactCourse,
      });
    } else {
      cur.offeringCount += 1;
      if (entry.college) cur.colleges.push(entry.college);
      if (Number(entry.termCode) > Number(cur.latestTermCode)) {
        cur.latestTermCode = String(entry.termCode);
        cur.latestTermDescription = entry.termDescription;
        cur.title = entry.title;
        cur.sectionsCount = entry.sectionsCount ?? 0;
      }
    }
  }

  return [...grouped.values()]
    .map((course) => ({
      subject: course.subject,
      courseNumber: course.courseNumber,
      code: `${course.subject} ${course.courseNumber}`,
      title: course.title,
      college: uniqueSorted(course.colleges.filter(Boolean))[0] ?? null,
      latestTermCode: course.latestTermCode,
      latestTermDescription: course.latestTermDescription,
      offeringCount: course.offeringCount,
      sectionsCount: course.sectionsCount,
      campus,
    }))
    .sort((a, b) => {
      if (a.exactMatch !== b.exactMatch) return a.exactMatch ? -1 : 1;
      if (a.offeringCount !== b.offeringCount) return b.offeringCount - a.offeringCount;
      return `${a.subject} ${a.courseNumber}`.localeCompare(
        `${b.subject} ${b.courseNumber}`
      );
    })
    .slice(0, limit);
}

/**
 * Return the offering history for a specific course.
 *
 * @param {string} subject
 * @param {string} courseNumber
 * @param {object} [options]
 * @param {string} [options.campus]  - default "college-station"
 * @returns {object|null}  null if the course was never offered
 */
function buildCourseHistory(subject, courseNumber, options = {}) {
  const { campus = 'college-station' } = options;
  const index = loadCatalogIndex();

  const subj = String(subject ?? '').trim().toUpperCase();
  const num = String(courseNumber ?? '').trim().toUpperCase();

  const terms = index
    .filter(
      (entry) =>
        entry.subject === subj &&
        String(entry.courseNumber) === num &&
        campusMatches(entry.campus, campus)
    )
    .sort((a, b) => Number(b.termCode) - Number(a.termCode));

  if (terms.length === 0) return null;

  const latest = terms[0];

  return {
    subject: subj,
    courseNumber: num,
    code: `${subj} ${num}`,
    title: latest.title,
    campus,
    terms: terms.map((entry) => ({
      termCode: String(entry.termCode),
      termDescription: entry.termDescription,
      sectionsCount: entry.sectionsCount ?? 0,
    })),
  };
}

/**
 * Return sorted list of all unique subject codes.
 */
function listSubjects({ campus = 'college-station' } = {}) {
  const index = loadCatalogIndex();
  const subjects = new Set();
  for (const entry of index) {
    if (campusMatches(entry.campus, campus)) subjects.add(entry.subject);
  }
  return [...subjects].sort();
}

/**
 * Return all unique courses for a given subject, with title.
 * @returns {Array<{ courseNumber: string, title: string, code: string }>}
 */
function listCoursesBySubject(subject, { campus = 'college-station' } = {}) {
  const index = loadCatalogIndex();
  const subj = String(subject ?? '').trim().toUpperCase();
  const seen = new Map(); // courseNumber -> { title, latestTermCode }

  for (const entry of index) {
    if (entry.subject !== subj) continue;
    if (!campusMatches(entry.campus, campus)) continue;
    const num = String(entry.courseNumber);
    const existing = seen.get(num);
    if (!existing || Number(entry.termCode) > Number(existing.latestTermCode)) {
      seen.set(num, { title: entry.title, latestTermCode: String(entry.termCode) });
    }
  }

  const hours = loadCourseHours();

  return [...seen.entries()]
    .map(([courseNumber, { title }]) => ({
      courseNumber,
      title,
      code: `${subj} ${courseNumber}`,
      creditHours: hours[`${subj} ${courseNumber}`] ?? null,
    }))
    .sort((a, b) => a.courseNumber.localeCompare(b.courseNumber, undefined, { numeric: true }));
}

module.exports = { searchCourses, buildCourseHistory, listSubjects, listCoursesBySubject, loadCourseHours };
