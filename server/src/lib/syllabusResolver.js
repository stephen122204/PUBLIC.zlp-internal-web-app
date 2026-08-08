'use strict';
/**
 * Resolve a syllabus PDF link for a professor teaching a course.
 *
 * TAMU's public syllabus PDF endpoint is keyed by CRN + termCode. We try, in
 * order:
 *   1. The term actually being viewed — its sections (with CRNs) are already
 *      fetched by the caller, so this costs nothing extra.
 *   2. The term the grade-distribution scrape says the professor last taught
 *      (may lag reality — grade reports are released well after a term ends).
 *   3. A bounded walk backward through prior terms, in case grade history is
 *      missing entirely (new professor, ungraded/rare course, or the scrape
 *      simply hasn't caught up) but an older syllabus is still on file.
 * The first term with an uploaded PDF wins. Many sections have no syllabus on
 * file, so a candidate is only accepted after confirming the PDF actually
 * resolves (HTTP 200, application/pdf) — we never want to show a dead link.
 */

const { request: httpsRequest } = require('https');
const { getCourseSections } = require('./courseSections');
const { instructorKeys } = require('./gradeDistributions');

const HOWDY_BASE_URL = process.env.HOWDY_BASE_URL ?? 'https://howdy.tamu.edu';
const PDF_CHECK_TIMEOUT_MS = 4000;
// How many terms to walk backward past the current/last-taught term when
// neither resolves — bounds worst-case Howdy calls per unmatched professor.
const MAX_BACKWARD_TERMS = 4;
// Availability rarely changes; cache resolved results (URL or null) for half a day.
const RESOLVE_CACHE_TTL_MS = 1000 * 60 * 60 * 12;

/** @type {Map<string, { value: {url: string, termCode: string, termLabel: string|null}|null, expiresAt: number }>} */
const resolveCache = new Map();

const SEMESTER_DIGIT = { SPRING: '1', SUMMER: '2', FALL: '3' };
const SEMESTER_NAME = { 1: 'SPRING', 2: 'SUMMER', 3: 'FALL' };

/**
 * Convert a grade-report term label into a College-Station Howdy termCode.
 * "SPRING 2026" -> "202611", "FALL 2024" -> "202431". Returns null if unparseable.
 */
function termLabelToCode(termLabel) {
  const m = String(termLabel ?? '').trim().toUpperCase().match(/^(SPRING|SUMMER|FALL)\s+(\d{4})$/);
  if (!m) return null;
  const digit = SEMESTER_DIGIT[m[1]];
  return `${m[2]}${digit}1`; // trailing 1 = College Station campus
}

/** Inverse of termLabelToCode: "202611" -> "SPRING 2026". Returns null if unparseable. */
function termCodeToLabel(termCode) {
  const s = String(termCode ?? '');
  const m = s.match(/^(\d{4})([123])\d$/);
  if (!m) return null;
  return `${SEMESTER_NAME[Number(m[2])]} ${m[1]}`;
}

/** The College-Station termCode immediately before `termCode`, or null if unparseable. */
function previousTermCode(termCode) {
  const s = String(termCode ?? '');
  const m = s.match(/^(\d{4})([123])(\d)$/);
  if (!m) return null;
  const year = Number(m[1]);
  const sem = Number(m[2]);
  const campus = m[3];
  if (sem === 1) return `${year - 1}3${campus}`; // Spring -> prior Fall
  return `${year}${sem - 1}${campus}`; // Summer -> Spring, Fall -> Summer
}

/** Normalized key set for tolerant instructor matching (space-stripped). */
function normalizedKeys(name) {
  return new Set(instructorKeys(name).map((k) => k.replace(/\s+/g, '')));
}

function buildSyllabusPdfUrl(crn, termCode) {
  return `${HOWDY_BASE_URL}/main/api/class-search/syllabus-pdf?crn=${encodeURIComponent(
    crn
  )}&term=${encodeURIComponent(termCode)}`;
}

/** Find a CRN taught by `instructorName` within an already-fetched section list. */
function findCrnForInstructor(sections, instructorName) {
  const targetKeys = normalizedKeys(instructorName);
  if (targetKeys.size === 0) return null;
  const match = (sections ?? []).find((s) =>
    (s.instructors ?? []).some((n) => [...normalizedKeys(n)].some((k) => targetKeys.has(k)))
  );
  return match?.crn ?? null;
}

/**
 * Confirm the syllabus URL serves a real PDF. Reads only the response headers
 * (status + content-type) and aborts before downloading the body.
 * @returns {Promise<boolean>}
 */
function pdfExists(url) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const req = httpsRequest(
        new URL(url),
        { method: 'GET', headers: { accept: 'application/pdf', 'user-agent': 'zlp-scheduler/1.0' } },
        (res) => {
          const ok =
            res.statusCode === 200 &&
            String(res.headers['content-type'] ?? '').toLowerCase().includes('pdf');
          res.destroy(); // don't download the (potentially multi-MB) body
          done(ok);
        }
      );
      req.setTimeout(PDF_CHECK_TIMEOUT_MS, () => req.destroy());
      req.on('error', () => done(false));
      req.end();
    } catch {
      done(false);
    }
  });
}

/** Try a specific term (fetching+caching its sections if needed) for a syllabus PDF. */
async function trySyllabusForTerm(subject, course, instructorName, termCode) {
  try {
    const sections = await getCourseSections(subject, course, termCode);
    const crn = findCrnForInstructor(sections, instructorName);
    if (!crn) return null;
    const url = buildSyllabusPdfUrl(crn, termCode);
    if (await pdfExists(url)) return { url, termCode, termLabel: termCodeToLabel(termCode) };
  } catch {
    // Howdy unavailable or term not served — degrade gracefully.
  }
  return null;
}

/**
 * Resolve a professor's syllabus PDF for a course, trying the viewed term
 * first, then their grade-history last-taught term, then walking backward.
 * @param {string} subject
 * @param {string} course
 * @param {string} instructorName  Howdy display name, e.g. "Shinjiro Sueda (P)"
 * @param {object} options
 * @param {string} options.termCode         Howdy termCode of the term being viewed
 * @param {Array}  [options.sections]       already-fetched sections for termCode (avoids a refetch)
 * @param {string|null} [options.lastTaughtTerm]  grade-report label, e.g. "SPRING 2026"
 * @returns {Promise<{url: string, termCode: string, termLabel: string|null}|null>}
 */
async function resolveInstructorSyllabus(subject, course, instructorName, options = {}) {
  const { termCode, sections, lastTaughtTerm } = options;
  if (!termCode) return null;

  const targetKeys = normalizedKeys(instructorName);
  if (targetKeys.size === 0) return null;

  const cacheKey = `${subject}|${course}|${[...targetKeys].join(',')}|${termCode}`;
  const cached = resolveCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  // 1. The term already being viewed — sections are already in hand, no extra fetch.
  let result = null;
  const currentCrn = findCrnForInstructor(sections, instructorName);
  if (currentCrn) {
    const url = buildSyllabusPdfUrl(currentCrn, termCode);
    if (await pdfExists(url)) result = { url, termCode, termLabel: termCodeToLabel(termCode) };
  }

  const triedTerms = new Set([termCode]);

  // 2. The grade-distribution scrape's "last taught" term, if different.
  if (!result && lastTaughtTerm) {
    const lastCode = termLabelToCode(lastTaughtTerm);
    if (lastCode && !triedTerms.has(lastCode)) {
      triedTerms.add(lastCode);
      result = await trySyllabusForTerm(subject, course, instructorName, lastCode);
    }
  }

  // 3. Walk backward from the viewed term — covers professors with no (or
  //    stale) grade history whose most recent syllabus is from an older term.
  if (!result) {
    let code = termCode;
    for (let i = 0; i < MAX_BACKWARD_TERMS && !result; i += 1) {
      code = previousTermCode(code);
      if (!code) break;
      if (triedTerms.has(code)) continue;
      triedTerms.add(code);
      result = await trySyllabusForTerm(subject, course, instructorName, code);
    }
  }

  resolveCache.set(cacheKey, { value: result, expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS });
  return result;
}

/**
 * Enrich a gradeStats object in place: attach a syllabus PDF link to every
 * instructor for whom one resolves, regardless of whether they have matched
 * grade history (grade releases lag; syllabus uploads don't). Best-effort —
 * failures leave the fields absent. Runs all lookups concurrently.
 * @param {string} subject
 * @param {string} course
 * @param {string} termCode    Howdy termCode of the term being viewed
 * @param {Array}  sections    already-fetched sections for termCode
 * @param {object} gradeStats  from getCourseGradeStats
 * @returns {Promise<object>} the same gradeStats
 */
async function attachSyllabusLinks(subject, course, termCode, sections, gradeStats) {
  const instructors = gradeStats?.instructors ?? [];
  await Promise.all(
    instructors.map(async (it) => {
      const result = await resolveInstructorSyllabus(subject, course, it.instructor, {
        termCode,
        sections,
        lastTaughtTerm: it.lastTaught?.term ?? null,
      });
      if (result) {
        it.lastTaughtSyllabusUrl = result.url;
        it.syllabusTermLabel = result.termLabel;
      }
    })
  );
  return gradeStats;
}

module.exports = {
  resolveInstructorSyllabus,
  attachSyllabusLinks,
  termLabelToCode,
  termCodeToLabel,
  previousTermCode,
};
