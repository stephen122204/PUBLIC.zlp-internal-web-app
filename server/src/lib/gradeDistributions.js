'use strict';
/**
 * Runtime lookup for scraped TAMU grade-distribution data.
 *
 * Loads server/data/grade-distributions.json (built offline by
 * scripts/build-grade-distributions.mjs) and, for a course + the instructors
 * teaching it this term, returns each instructor's historical GPA for THAT
 * course: overall (enrollment-weighted), the most recent term taught, and the
 * prior term. Returns null/empty when there's no match (→ UI shows "n/a").
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', '..', 'data', 'grade-distributions.json');

let cache = null;
let cacheMtime = 0;
function load() {
  // Reload when the data file's mtime changes (e.g. after a scrape refresh),
  // so the running server picks up new terms without a restart. statSync is cheap.
  let mtime = 0;
  try { mtime = fs.statSync(DATA_PATH).mtimeMs; } catch { /* file not present yet */ }
  if (cache && mtime === cacheMtime) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    cacheMtime = mtime;
  } catch {
    if (!cache) cache = { courses: {}, scope: null, generatedAt: null }; // not built yet — degrade gracefully
  }
  return cache;
}

/**
 * Normalize a Howdy instructor name to the grade-report key form "LASTNAME I".
 * "Shinjiro Sueda (P)" → "SUEDA S".  Returns { primary, joined } keys
 * (joined collapses multi-word last names, e.g. "Van Buren" → "VANBUREN J").
 */
function instructorKeys(howdyName) {
  if (!howdyName) return [];
  const clean = String(howdyName).replace(/\([^)]*\)/g, '').replace(/[.,]/g, '').trim();
  const tokens = clean.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const initial = tokens[0][0].toUpperCase();
  if (tokens.length === 1) return [tokens[0].toUpperCase()];

  const last = tokens[tokens.length - 1].toUpperCase();
  const lastTwo = (tokens[tokens.length - 2] + tokens[tokens.length - 1]).toUpperCase();
  const keys = [`${last} ${initial}`];
  if (tokens.length >= 3) keys.push(`${lastTwo} ${initial}`);
  return keys;
}

/** Build a course's instructor map keyed by a normalized (space-stripped) form for tolerant matching. */
function courseInstructorIndex(courseEntry) {
  const idx = new Map();
  for (const [reportKey, stats] of Object.entries(courseEntry.instructors ?? {})) {
    idx.set(reportKey, stats);                       // exact "LASTNAME I"
    idx.set(reportKey.replace(/\s+/g, ''), stats);   // space-stripped fallback
  }
  return idx;
}

/**
 * @param {string} subject  e.g. "CSCE"
 * @param {string} course   e.g. "221"
 * @param {string[]} instructorNames  Howdy instructor strings teaching this term
 * @returns {{ scope, generatedAt, instructors: Array<{ instructor, matched, overallGpa, overallStudents, lastTaught, priorTerm }> }}
 */
function getCourseGradeStats(subject, course, instructorNames = []) {
  const data = load();
  const courseKey = `${String(subject).toUpperCase().trim()} ${String(course).toUpperCase().trim()}`;
  const courseEntry = data.courses?.[courseKey];

  const uniqueNames = [...new Set(instructorNames.map((n) => String(n).trim()).filter(Boolean))];
  const idx = courseEntry ? courseInstructorIndex(courseEntry) : null;

  const instructors = uniqueNames.map((name) => {
    let stats = null;
    if (idx) {
      for (const key of instructorKeys(name)) {
        stats = idx.get(key) ?? idx.get(key.replace(/\s+/g, '')) ?? null;
        if (stats) break;
      }
    }
    if (!stats) return { instructor: name, matched: false };
    return {
      instructor: name,
      matched: true,
      overallGpa: stats.overallGpa,
      overallStudents: stats.overallStudents,
      lastTaught: stats.terms?.[0] ?? null,   // { term, gpa, students, sections }
      priorTerm: stats.terms?.[1] ?? null,
    };
  });

  return {
    scope: data.scope ?? null,
    generatedAt: data.generatedAt ?? null,
    courseHasData: Boolean(courseEntry),
    instructors,
  };
}

module.exports = { getCourseGradeStats, instructorKeys };
