'use strict';
/**
 * Live section fetching from howdy.tamu.edu with in-memory TTL cache.
 *
 * Ported from reference/tamu-course-offering-history/lib/vercel-api.mjs.
 * Adapted to CommonJS; uses node:https for brotli/gzip-compressed responses.
 */

const { request: httpsRequest } = require('https');
const { brotliDecompressSync, gunzipSync, inflateSync } = require('zlib');

const HOWDY_BASE_URL =
  process.env.HOWDY_BASE_URL ?? 'https://howdy.tamu.edu';

const SECTION_CACHE_TTL_MS = (() => {
  const v = Number.parseInt(process.env.SECTION_CACHE_TTL_MS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 1000 * 60 * 60 * 2; // 2 h — catalog changes are rare
})();

const REQUEST_TIMEOUT_MS = (() => {
  const v = Number.parseInt(process.env.COURSE_SECTIONS_REQUEST_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? Math.max(v, 30000) : 45000;
})();

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 350;

/** @type {Map<string, {rows: Array, expiresAt: number}>} */
const sectionsCache = new Map();
/** @type {Map<string, Promise>} */
const pendingRequests = new Map();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeBuffer(buffer, contentEncoding) {
  const enc = String(contentEncoding ?? '').trim().toLowerCase();
  if (!enc || enc === 'identity') return buffer;
  if (enc === 'gzip' || enc === 'x-gzip') return gunzipSync(buffer);
  if (enc === 'deflate') return inflateSync(buffer);
  if (enc === 'br') return brotliDecompressSync(buffer);
  return buffer;
}

function getCached(termCode) {
  const entry = sectionsCache.get(termCode);
  if (!entry) return null;
  if (entry.expiresAt > Date.now()) return entry.rows;
  return null; // expired but still in map for stale-while-revalidate
}

function getStale(termCode) {
  return sectionsCache.get(termCode)?.rows ?? null;
}

function setCache(termCode, rows) {
  sectionsCache.set(termCode, { rows, expiresAt: Date.now() + SECTION_CACHE_TTL_MS });
}

/**
 * POST to Howdy /api/course-sections with retry + brotli support.
 * @param {string} termCode
 * @returns {Promise<Array>}
 */
async function postHowdyCourseSections(termCode) {
  const payload = JSON.stringify({
    startRow: 0,
    endRow: 0,
    termCode,
    publicSearch: 'Y',
  });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const timeoutMs = REQUEST_TIMEOUT_MS + attempt * 15000;
    try {
      const rows = await new Promise((resolve, reject) => {
        const targetUrl = new URL('/api/course-sections', HOWDY_BASE_URL);
        const req = httpsRequest(
          targetUrl,
          {
            method: 'POST',
            agent: false,
            headers: {
              accept: 'application/json',
              'accept-encoding': 'br, gzip, deflate',
              connection: 'close',
              'content-type': 'application/json; charset=utf-8',
              'content-length': Buffer.byteLength(payload),
              'user-agent': 'zlp-scheduler/1.0',
            },
          },
          (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
              const raw = Buffer.concat(chunks);
              const body = decodeBuffer(raw, res.headers['content-encoding']).toString(
                'utf8'
              );
              const code = res.statusCode ?? 0;
              if (code < 200 || code >= 300) {
                const err = new Error(
                  `Howdy returned ${code}: ${body.slice(0, 200)}`
                );
                err.statusCode = code;
                return reject(err);
              }
              try {
                resolve(JSON.parse(body));
              } catch (e) {
                reject(e);
              }
            });
            res.on('error', reject);
          }
        );

        req.setTimeout(timeoutMs, () => {
          const err = new Error(`Howdy request timed out after ${timeoutMs}ms`);
          err.statusCode = 504;
          req.destroy(err);
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });

      setCache(termCode, rows);
      return rows;
    } catch (err) {
      console.warn(`[course-sections] attempt ${attempt + 1} failed for term ${termCode}: ${err.message}`);
      const code = err.statusCode ?? 0;
      const canRetry =
        attempt < MAX_RETRIES && (code === 0 || code === 429 || code >= 500);
      if (!canRetry) throw err;
      await wait(RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

// ---------------------------------------------------------------------------
// Day abbreviation helper
// ---------------------------------------------------------------------------

const DAY_ABBREV = {
  Mon: 'M',
  Tue: 'T',
  Wed: 'W',
  Thu: 'R',
  Fri: 'F',
  Sat: 'S',
  Sun: 'U',
};

function daysString(daysArray) {
  if (!Array.isArray(daysArray) || daysArray.length === 0) return null;
  return daysArray.map((d) => DAY_ABBREV[d] ?? d).join('');
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function parseJsonField(raw, fallback = []) {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function mapSectionRow(row) {
  const instructors = parseJsonField(row.SWV_CLASS_SEARCH_INSTRCTR_JSON, []).map(
    (inst) => String(inst.NAME ?? '').trim()
  ).filter(Boolean);

  const meetings = parseJsonField(row.SWV_CLASS_SEARCH_JSON_CLOB, []).map((m) => {
    const days = [
      m.SSRMEET_MON_DAY ? 'Mon' : '',
      m.SSRMEET_TUE_DAY ? 'Tue' : '',
      m.SSRMEET_WED_DAY ? 'Wed' : '',
      m.SSRMEET_THU_DAY ? 'Thu' : '',
      m.SSRMEET_FRI_DAY ? 'Fri' : '',
      m.SSRMEET_SAT_DAY ? 'Sat' : '',
      m.SSRMEET_SUN_DAY ? 'Sun' : '',
    ].filter(Boolean);

    const building = String(m.SSRMEET_BLDG_CODE ?? '').trim();
    const room = String(m.SSRMEET_ROOM_CODE ?? '').trim();

    return {
      type: m.SSRMEET_MTYP_CODE ?? null,
      days: daysString(days),
      startTime: m.SSRMEET_BEGIN_TIME ?? null,
      endTime: m.SSRMEET_END_TIME ?? null,
      location: [building, room].filter(Boolean).join(' ') || null,
    };
  });

  const hoursLow = row.SWV_CLASS_SEARCH_HOURS_LOW != null ? Number(row.SWV_CLASS_SEARCH_HOURS_LOW) : null;

  return {
    crn: String(row.SWV_CLASS_SEARCH_CRN ?? ''),
    subject: String(row.SWV_CLASS_SEARCH_SUBJECT ?? ''),
    courseNumber: String(row.SWV_CLASS_SEARCH_COURSE ?? ''),
    section: String(row.SWV_CLASS_SEARCH_SECTION ?? ''),
    // Campus/site label, e.g. "College Station", "Galveston", "McAllen", or null
    // (Web Based / Study Abroad / Internship). Used to keep only College-Station
    // sections as algorithm inputs.
    site: row.SWV_CLASS_SEARCH_SITE != null ? String(row.SWV_CLASS_SEARCH_SITE).trim() : null,
    title: String(row.SWV_CLASS_SEARCH_TITLE ?? ''),
    hoursLow,
    instructors,
    meetings,
    openForRegistration:
      row.STUSEAT_OPEN === 'Y' ? true : row.STUSEAT_OPEN === 'N' ? false : null,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Fetch all section rows for the given term (cached).
 * @param {string} termCode
 * @returns {Promise<Array>}
 */
async function fetchSectionsForTerm(termCode) {
  const fresh = getCached(termCode);
  if (fresh) return fresh;

  // Stale-while-revalidate: if there's already a pending request, return it
  if (pendingRequests.has(termCode)) {
    return pendingRequests.get(termCode);
  }

  const pending = (async () => {
    const stale = getStale(termCode);
    try {
      return await postHowdyCourseSections(termCode);
    } catch (err) {
      if (stale) {
        console.warn(
          `[course-sections] using stale cache for term ${termCode}: ${err.message}`
        );
        return stale;
      }
      throw err;
    } finally {
      pendingRequests.delete(termCode);
    }
  })();

  pendingRequests.set(termCode, pending);
  return pending;
}

// Per-instance cache of MAPPED term rows (compact). Distinct from `sectionsCache` (raw).
/** @type {Map<string, {rows: Array, expiresAt: number}>} */
const mappedMemCache = new Map();

/**
 * Get the whole term's MAPPED section rows, using a three-tier cache so the 23 MB Howdy
 * fetch happens at most once per term per TTL (not on every serverless cold start):
 *   1. in-memory (this instance)  2. MongoDB (shared across instances)  3. live Howdy.
 * @param {string} termCode
 * @returns {Promise<Array>}
 */
async function getMappedTermRows(termCode) {
  const mem = mappedMemCache.get(termCode);
  if (mem && mem.expiresAt > Date.now()) return mem.rows;

  const TermSectionCache = require('../models/TermSectionCache');
  try {
    const doc = await TermSectionCache.findOne({ termCode }).lean();
    const age = doc?.fetchedAt ? Date.now() - new Date(doc.fetchedAt).getTime() : Infinity;
    if (doc && Array.isArray(doc.rows) && age < SECTION_CACHE_TTL_MS) {
      mappedMemCache.set(termCode, { rows: doc.rows, expiresAt: Date.now() + SECTION_CACHE_TTL_MS });
      return doc.rows;
    }
  } catch (err) {
    console.warn(`[course-sections] Mongo cache read failed for ${termCode}: ${err.message}`);
  }

  // Cache miss/stale → fetch the full term once, map, and persist for other instances.
  const raw = await fetchSectionsForTerm(termCode);
  const mapped = raw.map(mapSectionRow);
  mappedMemCache.set(termCode, { rows: mapped, expiresAt: Date.now() + SECTION_CACHE_TTL_MS });
  try {
    await TermSectionCache.findOneAndUpdate(
      { termCode },
      { termCode, rows: mapped, fetchedAt: new Date() },
      { upsert: true }
    );
  } catch (err) {
    console.warn(`[course-sections] Mongo cache write failed for ${termCode}: ${err.message}`);
  }
  return mapped;
}

/**
 * Get mapped sections for a specific course in a given term.
 * @param {string} subject
 * @param {string} courseNumber
 * @param {string} termCode
 * @returns {Promise<Array>}
 */
async function getCourseSections(subject, courseNumber, termCode) {
  const rows = await getMappedTermRows(termCode);
  const subj = String(subject).trim().toUpperCase();
  const num = String(courseNumber).trim().toUpperCase();

  return rows
    .filter((r) => String(r.subject).toUpperCase() === subj && String(r.courseNumber).toUpperCase() === num)
    .sort((a, b) => a.section.localeCompare(b.section, undefined, { numeric: true }));
}

module.exports = { fetchSectionsForTerm, getCourseSections, mapSectionRow };
