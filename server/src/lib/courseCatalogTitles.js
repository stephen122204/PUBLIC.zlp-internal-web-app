'use strict';
/**
 * On-demand lookup of official TAMU catalog course titles (proper Title Case, e.g.
 * "General Chemistry for Engineering Students") — the same source degreeGraphBuilder
 * uses to fill in node titles. Distinct from Howdy's course-search index
 * (lib/courseSearch.js), which returns ALL-CAPS abbreviated Banner titles.
 */
const { parseCourseCatalogPage, fetchHtml, CATALOG_BASE } = require('./degreeGraphBuilder');

const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h — catalog pages rarely change

/** @type {Map<string, {courses: Object, expiresAt: number}>} */
const subjectCache = new Map();
/** @type {Map<string, Promise<Object>>} */
const pendingFetches = new Map();

async function loadSubject(subject) {
  const cached = subjectCache.get(subject);
  if (cached && cached.expiresAt > Date.now()) return cached.courses;
  if (pendingFetches.has(subject)) return pendingFetches.get(subject);

  const promise = (async () => {
    const url = `${CATALOG_BASE}/undergraduate/course-descriptions/${subject.toLowerCase()}/`;
    const html = await fetchHtml(url);
    const courses = parseCourseCatalogPage(html);
    subjectCache.set(subject, { courses, expiresAt: Date.now() + CACHE_TTL_MS });
    return courses;
  })();
  pendingFetches.set(subject, promise);
  try {
    return await promise;
  } finally {
    pendingFetches.delete(subject);
  }
}

/**
 * Look up a single course's catalog title, e.g. "AERO 430" -> "Aerospace Structural
 * Vibrations". Returns null if the code is malformed or not found on the subject's page.
 * @param {string} code
 * @returns {Promise<string|null>}
 */
async function getCourseCatalogTitle(code) {
  const match = String(code ?? '').trim().toUpperCase().match(/^([A-Z]{2,5})\s*(\d{3}[A-Z]?)$/);
  if (!match) return null;
  const [, subject, number] = match;
  try {
    const courses = await loadSubject(subject);
    return courses[`${subject} ${number}`]?.title ?? null;
  } catch {
    return null;
  }
}

/**
 * Batch lookup of course prerequisites/corequisites from the official catalog pages.
 * Loads each subject page once (cached), then reads each code's parsed prereq/coreq lists.
 * @param {string[]} codes  e.g. ["CSCE 221", "MATH 151"]
 * @returns {Promise<Object>} { [normalizedCode]: { prereqs: string[], coreqs: string[] } }
 */
async function getCoursePrereqsBatch(codes) {
  const parsed = [];
  const subjects = new Set();
  for (const raw of codes ?? []) {
    const m = String(raw ?? '').trim().toUpperCase().match(/^([A-Z]{2,5})\s*(\d{3}[A-Z]?)$/);
    if (!m) continue;
    parsed.push({ norm: `${m[1]} ${m[2]}`, subject: m[1] });
    subjects.add(m[1]);
  }
  const bySubject = new Map();
  await Promise.all([...subjects].map(async (s) => {
    try { bySubject.set(s, await loadSubject(s)); } catch { bySubject.set(s, {}); }
  }));
  const out = {};
  for (const { norm, subject } of parsed) {
    const rec = bySubject.get(subject)?.[norm];
    out[norm] = { prereqs: rec?.prereqs ?? [], coreqs: rec?.coreqs ?? [], prereqGroups: rec?.prereqGroups ?? [] };
  }
  return out;
}

module.exports = { getCourseCatalogTitle, getCoursePrereqsBatch };
