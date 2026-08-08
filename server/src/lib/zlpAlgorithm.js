'use strict';
/**
 * ZLP Window-Finding Algorithm
 *
 * Finds the best 100-minute windows across M-F where the least number of
 * student course requests conflict.  Runs in two modes:
 *   required_only            — finalClassification === "required"
 *   required_plus_preferred  — finalClassification in ["required","preferred"]
 *
 * Evaluation is performed at the STUDENT-COURSE-REQUEST level:
 *   - In required_only mode: every request uses all available Howdy sections.
 *   - In required_plus_preferred mode: if a student selected preferred sections
 *     for a course request, only those preferred sections are used as the
 *     allowed option pool for that request. Students with no preferred sections
 *     selected still use all sections. This ensures an unconstrained student
 *     (Student B, all sections) does not hide a constrained student's (Student A,
 *     preferred sections only) conflict with the ZLP window.
 *   - If preferred CRNs are not found in the current term's section data, a
 *     warning is emitted and the request falls back to all sections ('fallback').
 *
 * Conflict/block aggregation happens AFTER per-request evaluation:
 *   conflictRequests = count of requests where every allowedOption overlaps ZLP
 *   affectedStudents = unique students with at least one conflictRequest
 *   blockedRequests  = count of requests where some (not all) allowedOptions overlap
 *   blockedStudents  = unique students with at least one blockedRequest
 *
 * Implements:
 *   - Per-request preferred-section constraint resolution (resolveRequestAllowedOptions)
 *   - Lab-only conflict tagging
 *   - Student-level schedule-combination feasibility (DFS backtracking)
 *   - Window ranking
 *   - Heatmap building
 *   - 12-hour AM/PM time formatting
 *   - Excel workbook generation (requires exceljs)
 */

const mongoose = require('mongoose');
const { fetchSectionsForTerm, mapSectionRow } = require('./courseSections');
const AlgorithmRun              = require('../models/AlgorithmRun');
const StudentCourseRequest      = require('../models/StudentCourseRequest');
const StudentSubmission         = require('../models/StudentSubmission');
const CohortMember              = require('../models/CohortMember');
const Cohort                    = require('../models/Cohort');
const SchedulingCycle           = require('../models/SchedulingCycle');
const User                      = require('../models/User');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BLOCK   = 100; // minutes
const DEFAULT_STEP    =   5; // minutes
const DEFAULT_START   = 480; // 8:00 AM in minutes since midnight
const DEFAULT_END     = 970; // 16:10 = last start of 100-min block (block ends at 17:50)
const WEEKDAYS        = ['M', 'T', 'W', 'R', 'F'];
const DAY_LABELS      = { M: 'M', T: 'T', W: 'W', R: 'R', F: 'F' };
const DAY_NAMES       = { M: 'Monday', T: 'Tuesday', W: 'Wednesday', R: 'Thursday', F: 'Friday' };
const MAX_SEARCH_NODES    = 50000; // DFS node cap per student-window
const DEFAULT_MAX_SEARCH_MS = 100;  // ms budget per student-window DFS call
const SOLVER_VERSION       = '4';   // bump when algorithm changes affect comparability

const LAB_TYPES = new Set(['LAB', 'L', 'LABORATORY', 'REC', 'RECITATION', 'SI', 'IND', 'FLD', 'PRC']);

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/**
 * Parse a time string to minutes since midnight.
 * Handles TWO formats returned by the Howdy/Banner API:
 *
 *   1. "HH:MM AM/PM"  — 12-hour format (what Howdy actually returns)
 *        "09:10 AM" → 550     "12:35 PM" → 755
 *        "01:50 PM" → 830     "12:00 AM" → 0 (midnight)
 *
 *   2. "HHMM" or "HH:MM" — 24-hour format (used internally / legacy)
 *        "0910" → 550   "1430" → 870   "09:10" → 550
 *
 * NOTE: Howdy returns 12-hour strings like "01:50 PM", NOT "1350" or "13:50".
 * Parsing them without the AM/PM handling treats every PM time as its AM
 * counterpart (e.g. 1:50 PM → 110 min instead of 830 min), which causes ALL
 * afternoon class sections to appear before the ZLP grid and never overlap
 * any candidate window → heatmap shows zero conflicts in the afternoon.
 */
function parseHHMM(str) {
  if (!str) return null;
  const s = String(str).trim();

  // --- Path 1: 12-hour "H:MM AM/PM" or "HH:MM AM/PM" ---
  const amPmMatch = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (amPmMatch) {
    let h        = parseInt(amPmMatch[1], 10);
    const m      = parseInt(amPmMatch[2], 10);
    const isPM   = amPmMatch[3].toUpperCase() === 'PM';
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    // Standard 12-hour → 24-hour conversion:
    //   12 AM (midnight) → 0     12 PM (noon) → 12
    //    1 PM            → 13    11 PM        → 23
    if (h === 12) h = isPM ? 12 : 0;
    else if (isPM) h += 12;
    return h * 60 + m;
  }

  // --- Path 2: 24-hour "HHMM" or "HH:MM" ---
  const clean = s.replace(':', '').padStart(4, '0');
  const h = parseInt(clean.slice(0, 2), 10);
  const m = parseInt(clean.slice(2, 4), 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

/**
 * Format minutes since midnight to 24-hour HH:MM string.
 * e.g. 480 → "08:00", 550 → "09:10", 970 → "16:10"
 */
function formatTime24h(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Half-open interval overlap: [startA, endA) vs [startB, endB).
 * Returns true if max(startA,startB) < min(endA,endB).
 */
function overlaps(startA, endA, startB, endB) {
  return Math.max(startA, startB) < Math.min(endA, endB);
}

// Concrete "section (day HH:MM–HH:MM)" labels for the given sections that overlap
// the window on `day` — so the UI can show exactly which chosen section/time clashes.
function sectionOverlapLabels(sections, day, winStart, winEnd) {
  return sections.map((o) => {
    const meet = o.meetings
      .filter((m) => m.days.includes(day) && overlaps(m.startMin, m.endMin, winStart, winEnd))
      .map((m) => `${day} ${formatTime24h(m.startMin)}–${formatTime24h(m.endMin)}`)[0] ?? null;
    const id = o.section ?? o.crn;
    return id ? (meet ? `${id} (${meet})` : String(id)) : meet;
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Secondary-meeting-type badge helper
// ---------------------------------------------------------------------------

const LAB_TYPE_KEYS = new Set(['LAB', 'L', 'LABORATORY']);
const REC_TYPE_KEYS = new Set(['REC', 'RECITATION']);

/**
 * Given the section options that overlap the ZLP window, determine whether
 * every overlapping meeting on the ZLP day is a secondary meeting (isLab),
 * and if so, which specific secondary types are involved.
 *
 * Returns:
 *   secondaryOnly        — true if all overlapping day-meetings are secondary
 *   secondaryOnlyLabel   — display label ("Lab only" | "Recitation only" |
 *                          "Lab/recitation only" | "Secondary only" | null)
 *   secondaryOverlapTypes — array of canonical type names e.g. ['Laboratory']
 */
function getSecondaryOnlyInfo(overlappingOptions, day, zlpStart, zlpEnd) {
  const overlapMeetings = overlappingOptions.flatMap((o) =>
    o.meetings.filter((m) => m.days.includes(day) && overlaps(m.startMin, m.endMin, zlpStart, zlpEnd))
  );

  if (overlapMeetings.length === 0) {
    return { secondaryOnly: false, secondaryOnlyLabel: null, secondaryOverlapTypes: [] };
  }

  if (!overlapMeetings.every((m) => m.isLab)) {
    return { secondaryOnly: false, secondaryOnlyLabel: null, secondaryOverlapTypes: [] };
  }

  const hasLab   = overlapMeetings.some((m) => LAB_TYPE_KEYS.has(String(m.type ?? '').toUpperCase()));
  const hasRec   = overlapMeetings.some((m) => REC_TYPE_KEYS.has(String(m.type ?? '').toUpperCase()));
  const hasOther = overlapMeetings.some((m) => {
    const t = String(m.type ?? '').toUpperCase();
    return !LAB_TYPE_KEYS.has(t) && !REC_TYPE_KEYS.has(t);
  });

  const types = [];
  if (hasLab) types.push('Laboratory');
  if (hasRec) types.push('Recitation');
  if (hasOther) {
    const otherTypes = [...new Set(
      overlapMeetings
        .filter((m) => { const t = String(m.type ?? '').toUpperCase(); return !LAB_TYPE_KEYS.has(t) && !REC_TYPE_KEYS.has(t); })
        .map((m) => m.type ? String(m.type) : 'Secondary')
    )];
    types.push(...otherTypes);
  }

  let label;
  if (hasLab && !hasRec && !hasOther)       label = 'Lab only';
  else if (hasRec && !hasLab && !hasOther)  label = 'Recitation only';
  else if (!hasOther)                       label = 'Lab/recitation only';
  else                                      label = 'Secondary only';

  return { secondaryOnly: true, secondaryOnlyLabel: label, secondaryOverlapTypes: types };
}

/**
 * Compute the merged secondaryOnlyLabel from a union Set of type names.
 * Used when aggregating across multiple students for the same course.
 */
function labelFromTypeSet(typeSet) {
  const hasLab   = typeSet.has('Laboratory');
  const hasRec   = typeSet.has('Recitation');
  const hasOther = [...typeSet].some((t) => t !== 'Laboratory' && t !== 'Recitation');
  if (!hasLab && !hasRec && !hasOther) return null;
  if (hasLab && !hasRec && !hasOther)      return 'Lab only';
  if (hasRec && !hasLab && !hasOther)      return 'Recitation only';
  if ((hasLab || hasRec) && !hasOther)     return 'Lab/recitation only';
  return 'Secondary only';
}

// ---------------------------------------------------------------------------
// Section normalisation
// ---------------------------------------------------------------------------

const DAY_NORM = {
  M: 'M', MON: 'M',
  T: 'T', TUE: 'T',
  W: 'W', WED: 'W',
  R: 'R', THU: 'R',
  F: 'F', FRI: 'F',
};

function normDays(daysStr) {
  if (!daysStr) return [];
  // Could be "MWF", "TR", "M", etc.
  // Split into 1-char or 2-char tokens
  const str = String(daysStr).toUpperCase().trim();
  const out = [];
  let i = 0;
  while (i < str.length) {
    // Try 2-char first
    if (i + 1 < str.length) {
      const two = str.slice(i, i + 2);
      if (DAY_NORM[two]) { out.push(DAY_NORM[two]); i += 2; continue; }
    }
    const one = str[i];
    if (DAY_NORM[one]) out.push(DAY_NORM[one]);
    i++;
  }
  return out;
}

/**
 * Given raw section rows from courseSections.js (mapSectionRow output),
 * build a map:  courseCode → [ sectionOption ]
 *
 * sectionOption = {
 *   crn, section, title,
 *   meetings: [ { days: ['M','W','F'], startMin, endMin, isLab } ]
 *   hasScheduledMeetings: bool
 * }
 */
/**
 * Only College-Station sections are valid algorithm inputs. The authoritative
 * signal is the section's SITE label (SWV_CLASS_SEARCH_SITE) — a College-Station
 * term fetch also returns Galveston, McAllen, Dallas, Fort Worth, etc. sections
 * (e.g. OCEN 265 sec 550 = Galveston, ESET 369 sec M01 = McAllen), plus null-site
 * Web Based / Study Abroad / Internship sections. None of those are in-person
 * College-Station meetings, so they must not count toward ZLP conflicts.
 * Section-number bands (550, M01, …) are NOT reliable — use the SITE label.
 */
function isCollegeStationSection(row) {
  return String(row?.site ?? '').trim().toLowerCase() === 'college station';
}

function normalizeSectionOptions(allSectionRows, courseCodes) {
  // Index rows by normalised "SUBJ NNN" course code, keeping only College-Station
  // sections (Galveston / McAllen / online / etc. are excluded from the input pool).
  const byCode = new Map();
  for (const row of allSectionRows) {
    if (!isCollegeStationSection(row)) continue;
    const code = `${row.subject} ${row.courseNumber}`.toUpperCase().trim();
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(row);
  }

  const result = {};
  for (const code of courseCodes) {
    const normCode = code.toUpperCase().trim();
    const rows = byCode.get(normCode) ?? [];
    const options = rows.map((row) => {
      const meetings = (row.meetings ?? []).map((m) => {
        const days     = normDays(m.days);
        const startMin = parseHHMM(m.startTime);
        const endMin   = parseHHMM(m.endTime);
        const typeUpper = String(m.type ?? '').toUpperCase();
        const isLab    = LAB_TYPES.has(typeUpper);
        return { days, startMin, endMin, isLab, type: m.type };
      }).filter((m) => m.days.length > 0 && m.startMin != null && m.endMin != null);

      const hasScheduledMeetings = meetings.length > 0;
      return { crn: row.crn, section: row.section, title: row.title, meetings, hasScheduledMeetings };
    });
    result[normCode] = options;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Overlap testers
// ---------------------------------------------------------------------------

/**
 * Does a section option overlap the ZLP window on the given day?
 */
function optionOverlapsZlpBlock(option, day, zlpStart, zlpEnd) {
  for (const m of option.meetings) {
    if (m.days.includes(day) && overlaps(m.startMin, m.endMin, zlpStart, zlpEnd)) {
      return true;
    }
  }
  return false;
}

/**
 * Do two section options have overlapping non-lab meetings?
 * Used during primary-group DFS: labs are checked separately by
 * checkLabCompatibility, so only lecture-type meetings matter here.
 * Falling back to full overlap when both options are lab-only (isPrimaryLabOnly).
 */
function primaryOverlapsOption(optA, optB) {
  const nonLabA = optA.meetings.filter((m) => !m.isLab);
  const nonLabB = optB.meetings.filter((m) => !m.isLab);
  // If either side has no non-lab meetings (e.g. lab-only promoted to primary),
  // fall back to checking all meetings.
  const meetingsA = nonLabA.length > 0 ? nonLabA : optA.meetings;
  const meetingsB = nonLabB.length > 0 ? nonLabB : optB.meetings;
  for (const mA of meetingsA) {
    for (const mB of meetingsB) {
      for (const dA of mA.days) {
        if (mB.days.includes(dA) && overlaps(mA.startMin, mA.endMin, mB.startMin, mB.endMin)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Do two section options overlap each other (any day/time pair)?
 */
function optionOverlapsOption(optA, optB) {
  for (const mA of optA.meetings) {
    for (const mB of optB.meetings) {
      for (const dA of mA.days) {
        if (mB.days.includes(dA) && overlaps(mA.startMin, mA.endMin, mB.startMin, mB.endMin)) {
          return true;
        }
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Student feasibility (backtracking DFS)
// ---------------------------------------------------------------------------

/**
 * Canonical meeting-pattern signature for a section option.
 * Two options with the same signature are schedule-equivalent for conflict purposes.
 * Using this to deduplicate before DFS dramatically reduces the search space.
 */
function meetingSignature(opt) {
  if (!opt.meetings || opt.meetings.length === 0) return 'async';
  return opt.meetings
    .map((m) => `${[...m.days].sort().join('')}:${m.startMin}-${m.endMin}`)
    .sort()
    .join('|');
}

// ---------------------------------------------------------------------------
// Primary scheduling groups (lecture/lab separation for smart DFS)
// ---------------------------------------------------------------------------

/**
 * Non-lab meeting-pattern signature for a section option.
 * Only non-lab meeting times contribute to the key; same-row lab/rec
 * component times are ignored.  Falls back to full meetingSignature for
 * sections that have no non-lab meetings (lab-only sections).
 */
function nonLabMeetingSignature(opt) {
  const nonLabMeetings = (opt.meetings ?? []).filter((m) => !m.isLab);
  if (nonLabMeetings.length === 0) return meetingSignature(opt);
  return nonLabMeetings
    .map((m) => `${[...m.days].sort().join('')}:${m.startMin}-${m.endMin}`)
    .sort()
    .join('|');
}

/**
 * Split a course's section options into primary scheduling groups
 * (lecture/seminar) and secondary options (lab/recitation).
 *
 * A section is "primary"  if it has ≥1 non-lab scheduled meeting.
 * A section is "lab-only" if ALL its scheduled meetings are lab-type.
 * A section is "async"    if it has no scheduled meetings at all.
 *
 * Primary sections are collapsed by their non-lab meeting signature so that
 * multiple sections sharing the same lecture time reduce to one representative.
 * If no primary sections exist, lab sections are promoted to primary
 * (lab-only course treatment).
 *
 * @param {object[]} options  array of sectionOption objects
 * @returns {{ primaryGroups, labOptions, asyncOptions, isPrimaryLabOnly }}
 *   primaryGroups — [{ sig, representative: sectionOption, sections: sectionOption[] }]
 *   labOptions    — lab-only sectionOptions (secondary; used for post-DFS check)
 *   asyncOptions  — async sectionOptions
 *   isPrimaryLabOnly — true when labs were promoted to primary
 */
function buildPrimarySchedulingGroups(options) {
  const primary = options.filter(
    (o) => o.hasScheduledMeetings && o.meetings.some((m) => !m.isLab)
  );
  const labOnly = options.filter(
    (o) => o.hasScheduledMeetings && o.meetings.length > 0 && o.meetings.every((m) => m.isLab)
  );
  const async_ = options.filter((o) => !o.hasScheduledMeetings);

  // If no lecture-type sections exist, promote labs to primary
  const usePrimary       = primary.length > 0 ? primary : labOnly;
  const isPrimaryLabOnly = primary.length === 0 && labOnly.length > 0;

  const groupMap = new Map();
  for (const opt of usePrimary) {
    const sig = isPrimaryLabOnly ? meetingSignature(opt) : nonLabMeetingSignature(opt);
    if (!groupMap.has(sig)) {
      groupMap.set(sig, { sig, representative: opt, sections: [opt] });
    } else {
      groupMap.get(sig).sections.push(opt);
    }
  }

  return {
    primaryGroups:    [...groupMap.values()],
    labOptions:       isPrimaryLabOnly ? [] : labOnly,
    asyncOptions:     async_,
    isPrimaryLabOnly,
  };
}

/**
 * After a valid primary (lecture) combination is chosen, greedily verify that
 * at least one lab option is compatible per course that has separate lab sections.
 * This is a lightweight O(N × L) pass, not a full DFS over labs.
 *
 * @returns {true|false|'skipped'}
 *   true     — all courses with labs found a compatible lab
 *   false    — some course has no compatible lab (this primary combo is infeasible)
 *   'skipped' — no course had separate lab options to check
 */
function checkLabCompatibility(chosenPrimaryReps, labOptionsByCourse, courseCodes) {
  const chosenLabs = [];
  let   anyChecked = false;

  for (let i = 0; i < courseCodes.length; i++) {
    const labs = labOptionsByCourse[courseCodes[i]];
    if (!labs || labs.length === 0) continue;

    anyChecked = true;
    // Deduplicate labs by meeting signature before checking
    const seen = new Set();
    const uniqueLabs = labs.filter((lab) => {
      const sig = meetingSignature(lab);
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });

    const placed = uniqueLabs.find(
      (lab) =>
        !chosenPrimaryReps.some((rep) => optionOverlapsOption(lab, rep)) &&
        !chosenLabs.some((prev) => optionOverlapsOption(lab, prev))
    );
    if (!placed) return false;
    chosenLabs.push(placed);
  }

  return anyChecked ? true : 'skipped';
}

/**
 * Determine whether self-conflict DFS is necessary for a student in this window.
 *
 * DFS is only meaningful when at least one course has very few surviving PRIMARY
 * scheduling groups (distinct lecture-time patterns) after ZLP filtering.
 * When all courses have ≥3 surviving primary groups, self-conflict is very
 * unlikely and DFS is skipped (selfConflictStatus = 'skipped_low_risk').
 *
 * A course with ≤2 surviving primary groups is "constrained" and warrants DFS.
 *
 * @param {object} survivingOptions  courseCode → [sectionOption]  (post ZLP-filter)
 * @returns {{ shouldCheck: bool, constrainedCourses, reason }}
 */
function shouldRunSelfConflictCheck(survivingOptions) {
  const constrainedCourses = [];
  for (const [code, options] of Object.entries(survivingOptions)) {
    if (!options || options.length === 0) continue;
    const { primaryGroups } = buildPrimarySchedulingGroups(options);
    if (primaryGroups.length === 0) continue;  // async/empty → no scheduling constraint
    if (primaryGroups.length >= 3)  continue;  // ≥3 primary patterns → low self-conflict risk
    constrainedCourses.push({ code, primaryGroupsAfterZlp: primaryGroups.length });
  }
  return {
    shouldCheck:        constrainedCourses.length > 0,
    constrainedCourses,
    reason: constrainedCourses.length > 0
      ? 'constrained_primary_groups'
      : 'all_courses_have_ample_options',
  };
}

/**
 * Attempt to find a valid combination of one section per course such that
 * no two chosen sections overlap each other (the self-conflict check).
 *
 * Uses PRIMARY scheduling groups (lecture-time patterns) to reduce the
 * DFS search space.  Lab-only sections are separated and checked with a
 * greedy compatibility pass after the primary DFS succeeds.
 *
 * Optimisations:
 *   1. Build primary groups per course; sort most-constrained-first.
 *   2. DFS over primary group representatives (not raw section count).
 *   3. Quick failure: two single-group courses whose reps conflict.
 *   4. Quick success: greedy forward-check over primary representatives.
 *   5. After any full-depth success: greedy lab compatibility check.
 *   6. Memoize failed (courseIdx, committed-signature) states.
 *   7. Time-budget: return unknown rather than a wrong answer on timeout.
 *
 * @param {object} survivingOptions  courseCode → [ sectionOption ]
 * @param {number} maxMs             milliseconds budget (default DEFAULT_MAX_SEARCH_MS)
 * @returns {{ feasible, selfConflict, unknown, selectedCombination, searchNodes, searchLimit }}
 */
function findFeasibleScheduleCombination(survivingOptions, maxMs = DEFAULT_MAX_SEARCH_MS) {
  const deadline    = Date.now() + maxMs;
  const searchLimit = MAX_SEARCH_NODES;
  const QUICK       = { selectedCombination: [], searchNodes: 0, searchLimit };

  const allCourses = Object.keys(survivingOptions);
  if (allCourses.length === 0) {
    return { feasible: true, selfConflict: false, unknown: false, ...QUICK };
  }

  // --- Build primary groups and lab pools per course ---
  const primaryGroupsByCourse = {};
  const labOptionsByCourse    = {};
  for (const code of allCourses) {
    const { primaryGroups, labOptions, asyncOptions } =
      buildPrimarySchedulingGroups(survivingOptions[code]);
    if (primaryGroups.length === 0 && asyncOptions.length > 0) {
      // Fully async course — no scheduling constraint; exclude from DFS
      continue;
    }
    primaryGroupsByCourse[code] = primaryGroups;
    labOptionsByCourse[code]    = labOptions;
  }

  // Sort by most constrained (fewest primary groups) first
  const courses = Object.keys(primaryGroupsByCourse).sort(
    (a, b) => primaryGroupsByCourse[a].length - primaryGroupsByCourse[b].length
  );

  if (courses.length === 0) {
    return { feasible: true, selfConflict: false, unknown: false, ...QUICK };
  }

  // --- Quick failure: any course with 0 primary groups ---
  for (const code of courses) {
    if (primaryGroupsByCourse[code].length === 0) {
      return { feasible: false, selfConflict: true, unknown: false, ...QUICK };
    }
  }

  // --- Quick failure: two single-group courses whose reps conflict ---
  const singleCodes = courses.filter((c) => primaryGroupsByCourse[c].length === 1);
  for (let i = 0; i < singleCodes.length; i++) {
    for (let j = i + 1; j < singleCodes.length; j++) {
      const repA = primaryGroupsByCourse[singleCodes[i]][0].representative;
      const repB = primaryGroupsByCourse[singleCodes[j]][0].representative;
      if (primaryOverlapsOption(repA, repB)) {
        return { feasible: false, selfConflict: true, unknown: false,
                 ...QUICK, searchNodes: singleCodes.length };
      }
    }
  }

  // --- Quick success: greedy forward-check over primary representatives ---
  {
    const greedyReps  = [];
    const greedyCodes = [];
    let ok = true;
    for (const code of courses) {
      const placed = primaryGroupsByCourse[code].find(
        (g) => !greedyReps.some((prev) => primaryOverlapsOption(g.representative, prev))
      );
      if (placed) { greedyReps.push(placed.representative); greedyCodes.push(code); }
      else         { ok = false; break; }
    }
    if (ok) {
      const labResult = checkLabCompatibility(greedyReps, labOptionsByCourse, greedyCodes);
      if (labResult !== false) {
        return { feasible: true, selfConflict: false, unknown: false,
                 selectedCombination: greedyReps, searchNodes: courses.length, searchLimit };
      }
    }
  }

  // --- DFS with failure memoisation over primary representatives ---
  const failedStates = new Set();
  let searchNodes    = 0;
  const chosen       = [];
  const chosenCodes  = [];

  function stateKey(idx) {
    return `${idx}:${chosen.map(meetingSignature).sort().join('|')}`;
  }

  function dfs(idx) {
    if (idx === courses.length) {
      // Verify lab compatibility for the chosen primary combination
      const labResult = checkLabCompatibility(chosen, labOptionsByCourse, chosenCodes);
      return labResult !== false ? true : false;
    }
    if (searchNodes > searchLimit) return null;
    if (Date.now() >= deadline)   return null;

    const key = stateKey(idx);
    if (failedStates.has(key)) return false;

    const code   = courses[idx];
    const groups = primaryGroupsByCourse[code];
    for (const g of groups) {
      searchNodes++;
      let conflict = false;
      for (const prev of chosen) {
        if (primaryOverlapsOption(g.representative, prev)) { conflict = true; break; }
      }
      if (conflict) continue;
      chosen.push(g.representative);
      chosenCodes.push(code);
      const result = dfs(idx + 1);
      if (result === true)  return true;
      if (result === null)  return null;
      chosen.pop();
      chosenCodes.pop();
    }
    failedStates.add(key);
    return false;
  }

  const result = dfs(0);
  return {
    feasible:            result === true,
    selfConflict:        result === false,
    unknown:             result === null,
    selectedCombination: result === true ? [...chosen] : [],
    searchNodes,
    searchLimit,
  };
}

/**
 * Evaluate one student's feasibility for one ZLP window.
 *
 * @param {object} studentData  { userId, name, requests: [ { code, title, classification } ] }
 * @param {object} sectionsByCode  { courseCode: [ sectionOption ] }
 * @param {string} day
 * @param {number} zlpStart minutes
 * @param {number} zlpEnd   minutes
 * @returns {object} evaluation result
 */
function evaluateStudentFeasibilityForWindow(studentData, sectionsByCode, day, zlpStart, zlpEnd, legacyMode = false) {
  const directConflicts   = [];
  const blockedCourses    = [];
  const survivingOptions  = {};
  const warnings          = [];

  for (const req of studentData.requests) {
    const code    = req.code.toUpperCase().trim();
    // Use the per-request allowedOptions resolved by resolveRequestAllowedOptions.
    // Falls back to global sectionsByCode if allowedOptions was not pre-resolved
    // (e.g. when evaluateStudentFeasibilityForWindow is called directly in tests).
    const options = req.allowedOptions ?? sectionsByCode[code];

    // Did the student restrict this course to a subset of sections (when other
    // sections existed)? If so, any resulting conflict is driven by their own
    // preference, not by the course being unschedulable. Used to tag conflicts.
    const totalSectionsAvailable = req.allOptions?.length ?? options?.length ?? 0;
    const narrowedByChoice       =
      req.constraintMode === 'preferred' &&
      totalSectionsAvailable > (req.allowedOptions?.length ?? options?.length ?? 0);
    const preferredSectionsUsed  =
      req.constraintMode === 'preferred' ? (req.allowedOptions?.length ?? options?.length ?? 0) : null;

    if (!options || options.length === 0) {
      warnings.push(`No section data for ${code}`);
      // Treat as non-blocking with warning (don't crash)
      survivingOptions[code] = []; // empty → direct conflict if we're strict; we'll flag as warning
      continue;
    }

    // Separate options that overlap the ZLP block from those that don't
    const overlapping  = options.filter((o) => optionOverlapsZlpBlock(o, day, zlpStart, zlpEnd));
    const surviving    = options.filter((o) => !optionOverlapsZlpBlock(o, day, zlpStart, zlpEnd));

    // Handle asynchronous/no-meeting sections as non-blocking
    const asyncOptions = options.filter((o) => !o.hasScheduledMeetings);
    const effectiveSurviving = surviving.length > 0 ? surviving : asyncOptions;

    if (options.length > 0 && overlapping.length === options.length && asyncOptions.length === 0) {
      // Every section overlaps → direct conflict
      const labOnly = overlapping.every((o) =>
        o.meetings.filter((m) => m.days.includes(day) && overlaps(m.startMin, m.endMin, zlpStart, zlpEnd))
          .every((m) => m.isLab)
      );
      const secInfo = getSecondaryOnlyInfo(overlapping, day, zlpStart, zlpEnd);
      directConflicts.push({ code, title: req.title, classification: req.classification, labOnly, secondaryOnlyLabel: secInfo.secondaryOnlyLabel, secondaryOverlapTypes: secInfo.secondaryOverlapTypes, narrowedByChoice, preferredSectionsUsed, totalSectionsAvailable, chosenSectionLabels: narrowedByChoice ? sectionOverlapLabels(overlapping, day, zlpStart, zlpEnd) : [] });
    } else if (overlapping.length > 0 && effectiveSurviving.length > 0) {
      // Some overlap, some survive → blocked
      const labOnly = overlapping.every((o) =>
        o.meetings.filter((m) => m.days.includes(day) && overlaps(m.startMin, m.endMin, zlpStart, zlpEnd))
          .every((m) => m.isLab)
      );
      const secInfo = getSecondaryOnlyInfo(overlapping, day, zlpStart, zlpEnd);
      // Sections blocked specifically by a lecture (non-lab) meeting overlapping
      // the window — used when the UI filters to lecture-time blocks only.
      const lectureBlockedSections = overlapping.filter((o) =>
        o.meetings.some((m) => m.days.includes(day) && overlaps(m.startMin, m.endMin, zlpStart, zlpEnd) && !m.isLab)
      ).length;
      blockedCourses.push({ code, title: req.title, classification: req.classification, labOnly, secondaryOnlyLabel: secInfo.secondaryOnlyLabel, secondaryOverlapTypes: secInfo.secondaryOverlapTypes, narrowedByChoice, preferredSectionsUsed, totalSectionsAvailable, blockedSections: overlapping.length, lectureBlockedSections, totalSections: options.length, chosenSectionLabels: narrowedByChoice ? sectionOverlapLabels(overlapping, day, zlpStart, zlpEnd) : [] });
      survivingOptions[code] = effectiveSurviving;
    } else {
      // Clear — all survive or async
      survivingOptions[code] = effectiveSurviving.length > 0 ? effectiveSurviving : options;
    }
  }

  // If there are direct conflicts we already know this student can't make it for those courses.
  // Still run feasibility for non-conflicting courses.
  const feasibilityCodes = Object.keys(survivingOptions);

  // When legacy mode is active, skip DFS entirely — only direct conflicts and blocked matter.
  if (legacyMode || feasibilityCodes.length === 0) {
    return {
      feasible:           directConflicts.length === 0,
      selfConflict:       false,
      unknown:            false,
      selfConflictStatus: legacyMode ? 'legacy_mode' : 'no_surviving_options',
      directConflicts,
      blockedCourses,
      survivingOptions,
      searchNodes:        0,
      searchLimit:        MAX_SEARCH_NODES,
      warnings,
    };
  }

  // Check whether self-conflict DFS is warranted based on primary group count.
  // Skip DFS when all surviving courses have ≥3 distinct lecture-time patterns.
  const checkDecision = shouldRunSelfConflictCheck(survivingOptions);
  if (!checkDecision.shouldCheck) {
    return {
      feasible:                  directConflicts.length === 0,
      selfConflict:              false,
      unknown:                   false,
      selfConflictStatus:        'skipped_low_risk',
      directConflicts,
      blockedCourses,
      survivingOptions,
      selfConflictCheckDecision: checkDecision,
      searchNodes:               0,
      searchLimit:               MAX_SEARCH_NODES,
      warnings,
    };
  }

  const combo = findFeasibleScheduleCombination(survivingOptions);
  const selfConflictStatus =
    combo.selfConflict ? 'self_conflict_exact' :
    combo.unknown      ? 'unknown_timeout'      :
                         'feasible_exact';

  return {
    feasible:                  directConflicts.length === 0 && combo.feasible,
    selfConflict:              directConflicts.length === 0 && combo.selfConflict,
    unknown:                   combo.unknown,
    selfConflictStatus,
    directConflicts,
    blockedCourses,
    survivingOptions,
    selectedCombination:       combo.selectedCombination,
    selfConflictCheckDecision: checkDecision,
    searchNodes:               combo.searchNodes,
    searchLimit:               combo.searchLimit,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Candidate window generation
// ---------------------------------------------------------------------------

function generateCandidateWindows(params = {}) {
  const block    = params.blockLengthMinutes ?? DEFAULT_BLOCK;
  const step     = params.stepMinutes        ?? DEFAULT_STEP;
  const gridStart = params.gridStartMinutes  ?? DEFAULT_START;
  const gridEnd   = params.gridEndMinutes    ?? DEFAULT_END;
  const days     = params.weekdays           ?? WEEKDAYS;

  const windows = [];
  for (const day of days) {
    for (let start = gridStart; start <= gridEnd; start += step) {
      windows.push({ day, startMinutes: start, endMinutes: start + block });
    }
  }
  return windows;
}

// ---------------------------------------------------------------------------
// Window evaluation (course-level + student-level)
// ---------------------------------------------------------------------------

/**
 * Evaluate one candidate window against all student data.
 *
 * @param {object} win           { day, startMinutes, endMinutes }
 * @param {Array}  students      [ { userId, name, requests } ]
 * @param {object} sectionsByCode
 * @returns {object} window result (without rank yet)
 */
function evaluateWindow(win, students, sectionsByCode, legacyMode = false) {
  const { day, startMinutes, endMinutes } = win;

  // Aggregate course-level metrics across all students
  const courseConflictMap = new Map(); // code → { ...meta, requestCount, studentNames, labOnly }
  const courseBlockedMap  = new Map();

  let conflictRequests    = 0;
  let blockedRequests      = 0;
  let nonLabBlockedRequests = 0;
  const affectedStudentNames      = [];
  const blockedStudentNames       = [];
  const selfConflictStudentNames  = [];
  const selfConflictReasons       = [];
  const feasibilityWarnings       = [];
  const feasibilityUnknownStudents = [];
  let feasibleStudents = 0;

  // Per-status solver debug counts
  let feasibleExactCount      = 0;
  let selfConflictExactCount  = 0;
  let skippedLowRiskCount     = 0;
  let unknownTimeoutCount     = 0;
  const unknownTimeoutDetails = []; // { studentName, searchNodes, searchLimit, constrainedCourses }

  for (const student of students) {
    if (student.requests.length === 0) { feasibleStudents++; continue; }

    const eval_ = evaluateStudentFeasibilityForWindow(
      student, sectionsByCode, day, startMinutes, endMinutes, legacyMode
    );

    // Aggregate direct conflicts
    for (const c of eval_.directConflicts) {
      conflictRequests++;
      if (!affectedStudentNames.includes(student.name)) affectedStudentNames.push(student.name);
      if (!courseConflictMap.has(c.code)) {
        courseConflictMap.set(c.code, { code: c.code, title: c.title, classification: c.classification, requestCount: 0, affectedStudentNames: [], restrictedStudentNames: [], restrictedStudentSections: [], labOnly: c.labOnly, _secondaryTypeSet: new Set(c.secondaryOverlapTypes ?? []) });
      }
      const entry = courseConflictMap.get(c.code);
      entry.requestCount++;
      if (!entry.affectedStudentNames.includes(student.name)) entry.affectedStudentNames.push(student.name);
      if (c.narrowedByChoice && !entry.restrictedStudentNames.includes(student.name)) {
        entry.restrictedStudentNames.push(student.name);
        entry.restrictedStudentSections.push({ name: student.name, used: c.preferredSectionsUsed, total: c.totalSectionsAvailable, chosen: c.chosenSectionLabels ?? [] });
      }
      if (!c.labOnly) entry.labOnly = false; // only labOnly if ALL instances are lab-only
      if (c.secondaryOverlapTypes) for (const t of c.secondaryOverlapTypes) entry._secondaryTypeSet.add(t);
    }

    // Aggregate blocked
    for (const c of eval_.blockedCourses) {
      blockedRequests++;
      if (!c.labOnly) nonLabBlockedRequests++;
      if (!blockedStudentNames.includes(student.name)) blockedStudentNames.push(student.name);
      if (!courseBlockedMap.has(c.code)) {
        courseBlockedMap.set(c.code, { code: c.code, title: c.title, classification: c.classification, requestCount: 0, affectedStudentNames: [], restrictedStudentNames: [], restrictedStudentSections: [], labOnly: c.labOnly, blockedSections: null, lectureBlockedSections: null, totalSections: null, blockedFraction: null, _secondaryTypeSet: new Set(c.secondaryOverlapTypes ?? []) });
      }
      const entry = courseBlockedMap.get(c.code);
      entry.requestCount++;
      if (!entry.affectedStudentNames.includes(student.name)) entry.affectedStudentNames.push(student.name);
      if (c.narrowedByChoice && !entry.restrictedStudentNames.includes(student.name)) {
        entry.restrictedStudentNames.push(student.name);
        entry.restrictedStudentSections.push({ name: student.name, used: c.preferredSectionsUsed, total: c.totalSectionsAvailable, chosen: c.chosenSectionLabels ?? [] });
      }
      if (!c.labOnly) entry.labOnly = false;
      // Track the highest blocked fraction across students for this course
      // (x/N sections blocked). The highest fraction = most-impacted case.
      if (Number.isFinite(c.blockedSections) && Number.isFinite(c.totalSections) && c.totalSections > 0) {
        const frac = c.blockedSections / c.totalSections;
        if (entry.blockedFraction === null || frac > entry.blockedFraction) {
          entry.blockedFraction        = frac;
          entry.blockedSections        = c.blockedSections;
          entry.lectureBlockedSections = c.lectureBlockedSections;
          entry.totalSections          = c.totalSections;
        }
      }
      if (c.secondaryOverlapTypes) for (const t of c.secondaryOverlapTypes) entry._secondaryTypeSet.add(t);
    }

    // Self-conflict (skipped in legacy mode)
    if (eval_.selfConflict) {
      selfConflictStudentNames.push(student.name);
      selfConflictReasons.push({ student: student.name, reason: 'No valid primary-schedule combination found after removing ZLP-conflicting sections (proven by DFS over lecture-time groups).' });
    } else if (eval_.unknown) {
      feasibilityUnknownStudents.push(student.name);
      const checked = eval_.searchNodes ?? '?';
      const limit   = eval_.searchLimit  ?? MAX_SEARCH_NODES;
      feasibilityWarnings.push(`Feasibility unknown for ${student.name} (solver limit reached: ${checked}/${limit} nodes checked).`);
    } else if (eval_.directConflicts.length === 0) {
      feasibleStudents++;
    }

    // Track per-status solver counts for debug
    switch (eval_.selfConflictStatus) {
      case 'feasible_exact':      feasibleExactCount++;     break;
      case 'self_conflict_exact': selfConflictExactCount++; break;
      case 'skipped_low_risk':    skippedLowRiskCount++;    break;
      case 'unknown_timeout':
        unknownTimeoutCount++;
        unknownTimeoutDetails.push({
          studentName:       student.name,
          searchNodes:       eval_.searchNodes ?? 0,
          searchLimit:       eval_.searchLimit ?? MAX_SEARCH_NODES,
          constrainedCourses: eval_.selfConflictCheckDecision?.constrainedCourses ?? [],
        });
        break;
    }

    if (eval_.warnings.length) {
      feasibilityWarnings.push(...eval_.warnings.map((w) => `${student.name}: ${w}`));
    }
  }

  return {
    day,
    dayLabel:  DAY_LABELS[day] ?? day,
    dayName:   DAY_NAMES[day]  ?? day,
    startTime: formatTime24h(startMinutes),
    endTime:   formatTime24h(endMinutes),
    startMinutes,
    endMinutes,

    totalHardConflicts: legacyMode
      ? conflictRequests
      : conflictRequests + selfConflictStudentNames.length,
    conflictRequests,
    affectedStudents:    affectedStudentNames.length,
    affectedStudentNames,

    blockedRequests,
    nonLabBlockedRequests,
    blockedStudents:     blockedStudentNames.length,
    blockedStudentNames,

    selfConflictStudents: selfConflictStudentNames.length,
    selfConflictStudentNames,
    selfConflictReasons,

    feasibilityUnknownStudents,
    feasibilityUnknownCount: feasibilityUnknownStudents.length,
    feasibilityWarnings,

    uniqueConflictCourseCount: courseConflictMap.size,
    uniqueBlockedCourseCount:  courseBlockedMap.size,

    conflictCourses: [...courseConflictMap.values()].map(({ _secondaryTypeSet, ...rest }) => ({
      ...rest,
      secondaryOnlyLabel:   rest.labOnly ? labelFromTypeSet(_secondaryTypeSet) : null,
      secondaryOverlapTypes: rest.labOnly ? [..._secondaryTypeSet] : [],
    })),
    blockedCourses: [...courseBlockedMap.values()].map(({ _secondaryTypeSet, ...rest }) => ({
      ...rest,
      secondaryOnlyLabel:   rest.labOnly ? labelFromTypeSet(_secondaryTypeSet) : null,
      secondaryOverlapTypes: rest.labOnly ? [..._secondaryTypeSet] : [],
    }))
      // Highest blocked fraction first (most-impacted courses prioritized at top).
      .sort((a, b) => (b.blockedFraction ?? 0) - (a.blockedFraction ?? 0)),

    feasibleStudents,
    totalStudentsEvaluated: students.length,

    // Per-status solver counts (debug / audit)
    feasibilitySolverCounts: {
      feasible_exact:      feasibleExactCount,
      self_conflict_exact: selfConflictExactCount,
      skipped_low_risk:    skippedLowRiskCount,
      unknown_timeout:     unknownTimeoutCount,
    },
    unknownTimeoutDetails,
  };
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

function rankWindows(windows, legacyMode = false) {
  const DAY_ORDER = { M: 0, T: 1, W: 2, R: 3, F: 4 };
  const sorted = [...windows].sort((a, b) => {
    // Always rank by direct conflicts first
    if (a.conflictRequests !== b.conflictRequests) return a.conflictRequests - b.conflictRequests;
    if (a.affectedStudents !== b.affectedStudents) return a.affectedStudents - b.affectedStudents;
    // Self-conflict and unknown are part of official scoring (skipped in legacy mode)
    if (!legacyMode) {
      if (a.selfConflictStudents !== b.selfConflictStudents) return a.selfConflictStudents - b.selfConflictStudents;
    }
    if (a.nonLabBlockedRequests !== b.nonLabBlockedRequests) return (a.nonLabBlockedRequests ?? 0) - (b.nonLabBlockedRequests ?? 0);
    if (a.blockedRequests !== b.blockedRequests) return a.blockedRequests - b.blockedRequests;
    if (a.blockedStudents !== b.blockedStudents) return a.blockedStudents - b.blockedStudents;
    if (!legacyMode) {
      const uA = a.feasibilityUnknownCount ?? a.feasibilityUnknownStudents?.length ?? 0;
      const uB = b.feasibilityUnknownCount ?? b.feasibilityUnknownStudents?.length ?? 0;
      if (uA !== uB) return uA - uB;
    }
    if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
    return (DAY_ORDER[a.day] ?? 9) - (DAY_ORDER[b.day] ?? 9);
  });
  return sorted.map((w, i) => ({ ...w, rank: i + 1 }));
}

// ---------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------

/**
 * Build a heatmap structure:
 *   { startTime → { day → { conflictRequests, affectedStudents, selfBlockedStudents, rank } } }
 */
function buildHeatmap(rankedWindows, legacyMode = false) {
  const heatmap = {};
  for (const w of rankedWindows) {
    if (!heatmap[w.startTime]) heatmap[w.startTime] = {};
    const cell = {
      totalHardConflicts: w.totalHardConflicts ?? w.conflictRequests,
      conflictRequests: w.conflictRequests,
      affectedStudents: w.affectedStudents,
      blockedRequests:      w.blockedRequests,
      nonLabBlockedRequests: w.nonLabBlockedRequests ?? 0,
      rank:                  w.rank,
    };
    if (!legacyMode) {
      cell.selfConflictStudents    = w.selfConflictStudents;
      cell.feasibilityUnknownCount = w.feasibilityUnknownCount ?? w.feasibilityUnknownStudents?.length ?? 0;
    }
    heatmap[w.startTime][w.day] = cell;
  }
  return heatmap;
}

// ---------------------------------------------------------------------------
// Input builder
// ---------------------------------------------------------------------------

async function buildAlgorithmInput({ cohortId, schedulingCycleId, mode, includeDraftSubmissions }) {
  const warnings = [];

  // Fetch cohort
  const cohort = await Cohort.findById(cohortId).lean();
  if (!cohort) throw new Error('Cohort not found.');
  if (cohort.archivedAt) throw new Error('Cohort is archived.');

  // Fetch scheduling cycle
  const cycle = await SchedulingCycle.findById(schedulingCycleId).lean();
  if (!cycle) throw new Error('Scheduling cycle not found.');
  if (cycle.status === 'archived') throw new Error('Scheduling cycle is archived.');
  if (!cycle.termCode) throw new Error('Scheduling cycle has no termCode.');
  if (String(cycle.cohortId) !== String(cohortId)) throw new Error('Cycle does not belong to this cohort.');

  // Determine included classifications
  const includedClassifications = mode === 'required_only'
    ? ['required']
    : ['required', 'preferred'];

  // Only Sections-Preferred honors each student's chosen sections. Preferred
  // includes preferred courses but leaves all sections open (like Required).
  const useSectionPreferences = mode === 'required_plus_preferred';

  // Fetch active cohort members
  const members = await CohortMember.find({ cohortId, status: 'active' }).lean();
  if (members.length === 0) warnings.push('No active cohort members found.');

  const memberUserIds = members.map((m) => m.userId);

  // Fetch user name info (exclude demo student accounts)
  const users = await User.find({ _id: { $in: memberUserIds }, isDemoStudent: { $ne: true } }, { name: 1, email: 1 }).lean();
  const userMap = new Map(users.map((u) => [String(u._id), u]));

  // Fetch submissions — include full courseSnapshot for submitted students
  const StudentSubmission_ = require('../models/StudentSubmission');
  let submissionFilter = { schedulingCycleId, userId: { $in: memberUserIds } };
  if (!includeDraftSubmissions) {
    submissionFilter.status = 'submitted';
  }
  const submissions = await StudentSubmission_.find(submissionFilter).lean();

  if (submissions.length === 0) {
    warnings.push('No student submissions found for this cycle.');
  }

  // Partition: submitted-with-snapshot vs. needs-live-lookup
  const snapshotSubmissions = [];
  const liveUserIds          = [];

  for (const sub of submissions) {
    const hasSnapshot = Array.isArray(sub.courseSnapshot) && sub.courseSnapshot.length > 0;
    if (sub.status === 'submitted' && hasSnapshot) {
      snapshotSubmissions.push(sub);
    } else {
      liveUserIds.push(String(sub.userId));
    }
  }

  // -----------------------------------------------------------------------
  // Build byStudent map from snapshot data
  // -----------------------------------------------------------------------
  const byStudent = new Map();

  for (const sub of snapshotSubmissions) {
    const uid = String(sub.userId);
    const u   = userMap.get(uid);
    byStudent.set(uid, { userId: uid, name: u?.name ?? u?.email ?? uid, requests: [] });

    for (const snap of sub.courseSnapshot) {
      if (!includedClassifications.includes(snap.finalClassification)) continue;

      const preferredCRNs = useSectionPreferences
        ? (snap.preferredSections ?? []).map((p) => String(p.crn))
        : null;

      byStudent.get(uid).requests.push({
        requestId:      snap.originalCourseRequestId
                          ? String(snap.originalCourseRequestId)
                          : `${uid}_${snap.code}`,
        code:           snap.code,
        title:          snap.title,
        classification: snap.finalClassification,
        preferredCRNs,
      });
    }
  }

  // -----------------------------------------------------------------------
  // For students without snapshot, fall back to live StudentCourseRequest
  // -----------------------------------------------------------------------
  let liveRequests = [];
  if (liveUserIds.length > 0) {
    liveRequests = await StudentCourseRequest.find({
      schedulingCycleId,
      userId: { $in: liveUserIds.map((id) => mongoose.Types.ObjectId.createFromHexString(id)) },
      finalClassification: { $in: includedClassifications },
    }).lean();

    if (liveUserIds.length > 0 && liveRequests.length === 0) {
      warnings.push('Some students have no snapshot and no live course requests matching the selected mode.');
    }

    // Build preferred section CRN lookup for live requests (Sections-Preferred only)
    const reqIdToPreferredCRNs = new Map();
    if (useSectionPreferences && liveRequests.length > 0) {
      const SectionPref = require('../models/SectionPreference');
      const prefs = await SectionPref.find(
        { courseRequestId: { $in: liveRequests.map((r) => r._id) } },
        { courseRequestId: 1, crn: 1 }
      ).lean();
      for (const pref of prefs) {
        const key = String(pref.courseRequestId);
        if (!reqIdToPreferredCRNs.has(key)) reqIdToPreferredCRNs.set(key, new Set());
        reqIdToPreferredCRNs.get(key).add(String(pref.crn));
      }
    }

    for (const req of liveRequests) {
      const uid = String(req.userId);
      if (!byStudent.has(uid)) {
        const u = userMap.get(uid);
        byStudent.set(uid, { userId: uid, name: u?.name ?? u?.email ?? uid, requests: [] });
      }
      const preferredCRNs = useSectionPreferences
        ? [...(reqIdToPreferredCRNs.get(String(req._id)) ?? [])]
        : null;
      byStudent.get(uid).requests.push({
        requestId:      String(req._id),
        code:           req.code,
        title:          req.title,
        classification: req.finalClassification,
        preferredCRNs,
      });
    }
  }

  // Remove students with no matching requests
  for (const [uid, student] of byStudent) {
    if (student.requests.length === 0) byStudent.delete(uid);
  }

  const students = [...byStudent.values()];
  const totalRequests = students.reduce((n, s) => n + s.requests.length, 0);

  if (totalRequests === 0) {
    warnings.push(`No ${mode === 'required_only' ? 'required' : 'required or preferred'} course requests found.`);
  }

  // Unique course codes across all students
  const uniqueCodes = [...new Set(students.flatMap((s) => s.requests.map((r) => r.code.toUpperCase().trim())))];

  return {
    cohort,
    cycle,
    students,
    uniqueCodes,
    totalRequests,
    warnings,
    termCode: cycle.termCode,
  };
}

// ---------------------------------------------------------------------------
// Section fetching
// ---------------------------------------------------------------------------

async function fetchSectionsForAlgorithm(termCode, courseCodes) {
  const warnings = [];
  const unavailableCourses = [];

  let allMappedRows;
  let totalRawRows = 0;
  try {
    const rawRows = await fetchSectionsForTerm(termCode);
    totalRawRows = Array.isArray(rawRows) ? rawRows.length : 0;
    allMappedRows = Array.isArray(rawRows) ? rawRows.map(mapSectionRow) : [];
  } catch (err) {
    warnings.push(`Failed to fetch section data from Howdy: ${err.message}. Using empty section set.`);
    allMappedRows = [];
  }

  // Quick lookup to distinguish "no Howdy data at all" from "course not in term"
  const subjectsInTerm = new Set(allMappedRows.map((r) => r.subject.toUpperCase()));
  const allCodesInTerm = new Set(allMappedRows.map((r) => `${r.subject} ${r.courseNumber}`.toUpperCase().trim()));

  const sectionsByCode = normalizeSectionOptions(allMappedRows, courseCodes);

  for (const code of courseCodes) {
    const opts = sectionsByCode[code] ?? [];
    if (opts.length === 0) {
      unavailableCourses.push(code);
      const normCode  = code.toUpperCase().trim();
      const [subj]    = normCode.split(' ');
      const subjInTerm = subjectsInTerm.has(subj);
      if (totalRawRows === 0) {
        warnings.push(`No section data found for ${normCode} in termCode ${termCode}. Howdy returned no rows for this term — the term code may be wrong or the term has no data yet.`);
      } else if (!subjInTerm) {
        warnings.push(`No section data found for ${normCode} in termCode ${termCode}. Subject "${subj}" was not found in Howdy data for this term (${totalRawRows} total rows retrieved).`);
      } else if (!allCodesInTerm.has(normCode)) {
        warnings.push(`No section data found for ${normCode} in termCode ${termCode}. "${subj}" sections exist for this term, but not this specific course. The course may not be offered, or the course number may differ.`);
      } else {
        warnings.push(`No section data found for ${normCode} in termCode ${termCode}. Rows were returned by Howdy but no usable meeting options were parsed — check meeting day/time fields.`);
      }
    }
  }

  // Course section summary
  const courseSectionSummary = courseCodes.map((code) => {
    const opts = sectionsByCode[code] ?? [];
    const normCode = code.toUpperCase().trim();
    const [subj]   = normCode.split(' ');
    return {
      code,
      sectionsFound:      opts.length,
      status:             opts.length > 0 ? 'found' : 'not_found',
      subjectInTerm:      subjectsInTerm.has(subj),
      codeInTermRaw:      allCodesInTerm.has(normCode),
      totalTermRawRows:   totalRawRows,
    };
  });

  return { sectionsByCode, unavailableCourses, courseSectionSummary, warnings, totalRawRows, allMappedRows };
}

// ---------------------------------------------------------------------------
// Per-request allowed-options resolver
// ---------------------------------------------------------------------------

/**
 * Resolve allowedOptions for every student-course request based on preferred
 * section selections. Mutates student.requests in-place, adding:
 *
 *   allOptions       — all Howdy sections for this course
 *   preferredOptions — sections matching preferred CRNs (may be empty)
 *   allowedOptions   — the section pool used for conflict evaluation
 *   constraintMode   — 'all' | 'preferred' | 'fallback'
 *
 * Required Only: req.preferredCRNs === null → always uses all sections.
 * Required + Preferred:
 *   preferredCRNs empty []  → use all sections ('all')
 *   preferredCRNs non-empty, CRNs matched  → use preferred only ('preferred')
 *   preferredCRNs non-empty, no CRN matched → warn, fall back to all ('fallback')
 *
 * Core rule: conflict/block evaluation is per student-course request using
 * that request's allowedOptions. An unconstrained student (Student B, all
 * sections) never hides a constrained student's (Student A, preferred only)
 * conflict with the ZLP window.
 *
 * @returns {string[]} warnings generated during resolution
 */
function resolveRequestAllowedOptions(students, sectionsByCode) {
  const warnings = [];
  for (const student of students) {
    for (const req of student.requests) {
      const code       = req.code.toUpperCase().trim();
      const allOptions = sectionsByCode[code] ?? [];
      req.allOptions   = allOptions;

      if (!req.preferredCRNs || req.preferredCRNs.length === 0) {
        // required_only (null) OR req+pref with no preferred selections
        req.preferredOptions = [];
        req.allowedOptions   = allOptions;
        req.constraintMode   = 'all';
      } else {
        // req+pref with specific preferred CRN selections
        const preferredOptions = allOptions.filter(
          (o) => req.preferredCRNs.includes(String(o.crn)) ||
                 req.preferredCRNs.includes(String(o.section))
        );
        req.preferredOptions = preferredOptions;
        if (preferredOptions.length > 0) {
          req.allowedOptions = preferredOptions;
          req.constraintMode = 'preferred';
        } else {
          // Preferred CRNs not found in current term → fallback
          req.allowedOptions = allOptions;
          req.constraintMode = 'fallback';
          warnings.push(
            `${student.name}: preferred section(s) [${req.preferredCRNs.join(', ')}] for ${code} ` +
            `not found in current term data — falling back to all ${allOptions.length} section(s).`
          );
        }
      }
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Preferred hard-conflict impact (for Required Only runs)
// ---------------------------------------------------------------------------

/**
 * Fetch preferred-only course requests for all submitted students in a cycle.
 * Loads preferred section CRN constraints from snapshots / SectionPreference.
 * @returns {{ students, uniqueCodes, warnings }}
 */
async function buildPreferredStudentsInput({ cohortId, schedulingCycleId }) {
  const warnings = [];
  const SectionPref = require('../models/SectionPreference');

  const members = await CohortMember.find({ cohortId, status: 'active' }).lean();
  const memberUserIds = members.map((m) => m.userId);
  if (memberUserIds.length === 0) return { students: [], uniqueCodes: [], warnings };

  const users = await User.find(
    { _id: { $in: memberUserIds }, isDemoStudent: { $ne: true } },
    { name: 1, email: 1 }
  ).lean();
  const userMap = new Map(users.map((u) => [String(u._id), u]));

  const StudentSubmission_ = require('../models/StudentSubmission');
  const submissions = await StudentSubmission_.find(
    { schedulingCycleId, userId: { $in: memberUserIds }, status: 'submitted' }
  ).lean();

  const byStudent = new Map();

  // Build from snapshot preferred requests
  const snapshotSubs = submissions.filter(
    (s) => Array.isArray(s.courseSnapshot) && s.courseSnapshot.length > 0
  );
  for (const sub of snapshotSubs) {
    const uid = String(sub.userId);
    const u   = userMap.get(uid);
    if (!byStudent.has(uid)) {
      byStudent.set(uid, { userId: uid, name: u?.name ?? uid, email: u?.email ?? '', requests: [] });
    }
    for (const snap of sub.courseSnapshot) {
      const preferredCRNs = (snap.preferredSections ?? []).map((p) => String(p.crn));
      // Include in the preferred check if the course is classified preferred, OR
      // it is a REQUIRED course for which the student picked specific sections.
      // Required courses still run all-sections in the main algorithm; here we
      // additionally surface "what the student loses by narrowing" — so a course
      // can show partially blocked above AND as a section-choice direct conflict here.
      const isPreferred         = snap.finalClassification === 'preferred';
      const isRequiredWithPicks = snap.finalClassification === 'required' && preferredCRNs.length > 0;
      if (!isPreferred && !isRequiredWithPicks) continue;
      byStudent.get(uid).requests.push({
        requestId:      snap.originalCourseRequestId
          ? String(snap.originalCourseRequestId)
          : `${uid}_${snap.code}`,
        code:           snap.code,
        title:          snap.title,
        classification: snap.finalClassification,
        preferredCRNs,
      });
    }
  }

  // Live fallback for students without snapshots
  const snapshotUserIds = new Set(snapshotSubs.map((s) => String(s.userId)));
  const liveUserIds = submissions
    .filter((s) => !snapshotUserIds.has(String(s.userId)))
    .map((s) => String(s.userId));

  if (liveUserIds.length > 0) {
    const liveRequests = await StudentCourseRequest.find({
      schedulingCycleId,
      userId: { $in: liveUserIds.map((id) => mongoose.Types.ObjectId.createFromHexString(id)) },
      finalClassification: { $in: ['preferred', 'required'] },
    }).lean();

    const prefs = liveRequests.length > 0
      ? await SectionPref.find(
          { courseRequestId: { $in: liveRequests.map((r) => r._id) } },
          { courseRequestId: 1, crn: 1 }
        ).lean()
      : [];

    const reqIdToPreferredCRNs = new Map();
    for (const pref of prefs) {
      const key = String(pref.courseRequestId);
      if (!reqIdToPreferredCRNs.has(key)) reqIdToPreferredCRNs.set(key, new Set());
      reqIdToPreferredCRNs.get(key).add(String(pref.crn));
    }

    for (const req of liveRequests) {
      const preferredCRNs = [...(reqIdToPreferredCRNs.get(String(req._id)) ?? [])];
      // Preferred courses always count; required courses only when the student
      // narrowed to specific sections (otherwise it's a normal all-sections required).
      if (req.finalClassification === 'required' && preferredCRNs.length === 0) continue;
      const uid = String(req.userId);
      if (!byStudent.has(uid)) {
        const u = userMap.get(uid);
        byStudent.set(uid, { userId: uid, name: u?.name ?? uid, email: u?.email ?? '', requests: [] });
      }
      byStudent.get(uid).requests.push({
        requestId:      String(req._id),
        code:           req.code,
        title:          req.title,
        classification: req.finalClassification,
        preferredCRNs,
      });
    }
  }

  // Remove students with no preferred requests
  for (const [uid, student] of byStudent) {
    if (student.requests.length === 0) byStudent.delete(uid);
  }

  const students    = [...byStudent.values()];
  const uniqueCodes = [...new Set(
    students.flatMap((s) => s.requests.map((r) => r.code.toUpperCase().trim()))
  )];
  return { students, uniqueCodes, warnings };
}

/**
 * Evaluate preferred-only hard-conflict impact for one window.
 *
 * Only counts HARD conflicts against preferred courses:
 *   preferredDirectConflictRequests — preferred courses where ALL allowed/preferred
 *     sections overlap the ZLP window.
 *   preferredSelfConflictStudents   — students with no direct preferred conflict but
 *     unable to build a complete non-overlapping preferred schedule from remaining sections.
 *
 * Preferred BLOCKED requests (some sections survive) are intentionally excluded.
 * Does NOT affect the Required Only ranking.
 */
function evaluatePreferredImpactForOneWindow(win, preferredStudents, sectionsByCode, legacyMode = false) {
  const { day, startMinutes, endMinutes } = win;
  let preferredDirectConflictRequests     = 0;  // ALL direct conflicts (genuine + section-choice)
  let preferredGenuineDirectConflicts     = 0;  // direct conflicts NOT caused by section choice
  let preferredSelfConflictStudents       = 0;
  let preferredFeasibilityUnknownStudents = 0;
  const preferredAffectedStudentSet       = new Set();
  const preferredRestrictedStudentSet     = new Set();  // students whose impossibility is their own section narrowing
  const impactedStudents                  = [];

  // Per-status solver debug counts for preferred path
  let prefFeasibleExactCount      = 0;
  let prefSelfConflictExactCount  = 0;
  let prefSkippedLowRiskCount     = 0;
  let prefUnknownTimeoutCount     = 0;
  const prefUnknownTimeoutDetails = []; // { studentName, searchNodes, searchLimit, constrainedCourses }

  for (const student of preferredStudents) {
    if (student.requests.length === 0) continue;

    const eval_ = evaluateStudentFeasibilityForWindow(
      student, sectionsByCode, day, startMinutes, endMinutes, legacyMode
    );
    const studentImpacts = [];

    // Preferred direct conflicts
    for (const c of eval_.directConflicts) {
      preferredDirectConflictRequests++;
      preferredAffectedStudentSet.add(student.userId);
      // Section-choice conflicts (student narrowed when other sections existed)
      // count toward the per-student "restricted" metric, NOT genuine impossible
      // courses — the course itself is still schedulable on all sections.
      if (c.narrowedByChoice) preferredRestrictedStudentSet.add(student.userId);
      else                    preferredGenuineDirectConflicts++;
      const req            = student.requests.find(
        (r) => r.code.toUpperCase().trim() === c.code.toUpperCase().trim()
      );
      const allowedOptions = req?.allowedOptions ?? [];
      const overlapping    = allowedOptions.filter(
        (o) => optionOverlapsZlpBlock(o, day, startMinutes, endMinutes)
      );

      // Did the student narrow this course to a subset of sections when other
      // (non-preferred) sections existed? If so, the conflict is a product of
      // their own restriction — not the course being unschedulable.
      const totalSectionsAvailable = req?.allOptions?.length ?? allowedOptions.length;
      const narrowedByChoice       =
        req?.constraintMode === 'preferred' &&
        totalSectionsAvailable > allowedOptions.length;

      // Concrete labels (section number + meeting on the conflict day) for the
      // preferred sections that overlap the ZLP window, so the admin sees exactly
      // which chosen section/time drives the conflict.
      const overlappingSectionLabels = overlapping.map((o) => {
        const meet = o.meetings
          .filter((m) => m.days.includes(day) && overlaps(m.startMin, m.endMin, startMinutes, endMinutes))
          .map((m) => `${day} ${formatTime24h(m.startMin)}–${formatTime24h(m.endMin)}`)[0] ?? null;
        const id = o.section ?? o.crn;
        return id ? (meet ? `${id} (${meet})` : String(id)) : meet;
      }).filter(Boolean);

      studentImpacts.push({
        courseCode:             c.code,
        courseTitle:            c.title,
        classification:         c.classification ?? null,
        impactType:             'preferred_direct_conflict',
        labOnly:                c.labOnly ?? false,
        secondaryOnlyLabel:     c.secondaryOnlyLabel ?? null,
        secondaryOverlapTypes:  c.secondaryOverlapTypes ?? [],
        reason:                 narrowedByChoice
          ? `Student narrowed ${c.code} to ${allowedOptions.length} of ${totalSectionsAvailable} section(s); all chosen section(s) overlap the ZLP window.`
          : `All ${allowedOptions.length} ${req?.constraintMode === 'preferred' ? 'preferred' : 'available'} section(s) overlap the ZLP window.`,
        narrowedByChoice,
        preferredSectionsUsed:  req?.constraintMode === 'preferred' ? allowedOptions.length : null,
        totalSectionsAvailable,
        overlappingSectionLabels,
        overlappingSections:    overlapping.length,
        remainingSections:      0,
      });
    }

    // Preferred self-conflict
    if (eval_.selfConflict) {
      preferredSelfConflictStudents++;
      preferredAffectedStudentSet.add(student.userId);
      studentImpacts.push({
        courseCode:            null,
        courseTitle:           null,
        impactType:            'preferred_self_conflict',
        reason:                'No valid non-overlapping preferred schedule can be built from remaining sections after removing ZLP-overlapping sections.',
        preferredSectionsUsed: null,
        overlappingSections:   null,
        remainingSections:     null,
      });
    } else if (eval_.unknown) {
      preferredFeasibilityUnknownStudents++;
      studentImpacts.push({
        courseCode:            null,
        courseTitle:           null,
        impactType:            'preferred_unknown',
        reason:                `Feasibility unknown — solver limit reached (${eval_.searchNodes ?? 0}/${eval_.searchLimit ?? MAX_SEARCH_NODES} nodes).`,
        preferredSectionsUsed: null,
        overlappingSections:   null,
        remainingSections:     null,
      });
    }

    if (studentImpacts.length > 0) {
      impactedStudents.push({ studentName: student.name, studentEmail: student.email, impacts: studentImpacts });
    }

    // Track per-status solver counts for debug
    switch (eval_.selfConflictStatus) {
      case 'feasible_exact':      prefFeasibleExactCount++;     break;
      case 'self_conflict_exact': prefSelfConflictExactCount++; break;
      case 'skipped_low_risk':    prefSkippedLowRiskCount++;    break;
      case 'unknown_timeout':
        prefUnknownTimeoutCount++;
        prefUnknownTimeoutDetails.push({
          studentName:        student.name,
          searchNodes:        eval_.searchNodes ?? 0,
          searchLimit:        eval_.searchLimit ?? MAX_SEARCH_NODES,
          constrainedCourses: eval_.selfConflictCheckDecision?.constrainedCourses ?? [],
        });
        break;
    }
  }

  return {
    // Total impossible situations (genuine + section-choice + self) — drives the
    // warning banner and the impacted-students list gating.
    preferredHardConflicts:              preferredDirectConflictRequests + preferredSelfConflictStudents,
    // Genuinely impossible courses only (exclude section-choice restrictions) —
    // the course/section truly cannot be taken at this time regardless of choice.
    preferredGenuineImpossibleCourses:   preferredGenuineDirectConflicts + preferredSelfConflictStudents,
    preferredDirectConflictRequests,
    preferredGenuineDirectConflicts,
    preferredSelfConflictStudents,
    preferredAffectedStudents:           preferredAffectedStudentSet.size,
    // Distinct students whose impossibility is caused by their own section narrowing.
    preferredRestrictedStudents:         preferredRestrictedStudentSet.size,
    preferredFeasibilityUnknownStudents,
    impactedStudents,

    // Per-status solver counts (debug / audit)
    prefFeasibilitySolverCounts: {
      feasible_exact:      prefFeasibleExactCount,
      self_conflict_exact: prefSelfConflictExactCount,
      skipped_low_risk:    prefSkippedLowRiskCount,
      unknown_timeout:     prefUnknownTimeoutCount,
    },
    prefUnknownTimeoutDetails,
  };
}

/**
 * Compute preferred hard-conflict impact for all windows in a required_only run.
 * Attaches `preferredHardConflictImpact` to each window. Does NOT change ranking.
 * @param {{ rankedWindows, cohortId, schedulingCycleId, allMappedRows, legacyMode }}
 * @returns {{ windows, warnings }}
 */
async function computePreferredHardConflictImpact({
  rankedWindows, cohortId, schedulingCycleId, allMappedRows, legacyMode = false,
}) {
  const { students, uniqueCodes, warnings } =
    await buildPreferredStudentsInput({ cohortId, schedulingCycleId });

  const emptyImpact = {
    preferredHardConflicts:              0,
    preferredDirectConflictRequests:     0,
    preferredSelfConflictStudents:       0,
    preferredAffectedStudents:           0,
    preferredFeasibilityUnknownStudents: 0,
    impactedStudents:                    [],
  };

  if (students.length === 0 || uniqueCodes.length === 0) {
    return {
      windows: rankedWindows.map((w) => ({ ...w, preferredHardConflictImpact: emptyImpact })),
      warnings,
    };
  }

  // Normalise sections for preferred course codes using cached allMappedRows
  const sectionsByCode = normalizeSectionOptions(allMappedRows, uniqueCodes);

  // Resolve per-request allowed options (preferred section constraints)
  const resolveWarns = resolveRequestAllowedOptions(students, sectionsByCode);
  warnings.push(...resolveWarns);

  const windows = rankedWindows.map((w) => ({
    ...w,
    preferredHardConflictImpact: evaluatePreferredImpactForOneWindow(
      w, students, sectionsByCode, legacyMode
    ),
  }));

  return { windows, warnings };
}

// ---------------------------------------------------------------------------
// Main algorithm runner
// ---------------------------------------------------------------------------

/**
 * Prune AlgorithmRun collection globally to at most `limit` documents,
 * keeping the newest (deterministic sort: createdAt desc, _id desc).
 * Safe to call after parallel runs because it operates on the current
 * DB state at call time — there is no per-cohort/cycle/mode filter.
 *
 * @param {{ limit?: number, reason?: string }} opts
 */
async function pruneAlgorithmRunsGlobal({ limit = 12, reason = 'runtime' } = {}) {
  const totalBefore = await AlgorithmRun.countDocuments();
  console.log(`[algorithm retention] before count=${totalBefore} limit=${limit} reason=${reason}`);

  const runsToDelete = await AlgorithmRun.find({})
    .sort({ createdAt: -1, _id: -1 })
    .skip(limit)
    .select('_id mode cohortId schedulingCycleId createdAt')
    .lean();

  console.log(`[algorithm retention] toDelete=${runsToDelete.length}`);
  if (runsToDelete.length === 0) return;

  await AlgorithmRun.deleteMany({ _id: { $in: runsToDelete.map((r) => r._id) } });

  const totalAfter = await AlgorithmRun.countDocuments();
  console.log(`[algorithm retention] after count=${totalAfter}`);
}

/**
 * Run the ZLP algorithm for one mode.
 * Creates and saves an AlgorithmRun document.
 *
 * @returns {Promise<AlgorithmRun>} the saved run document (with results)
 */
async function runZlpAlgorithmForCycle({ cohortId, schedulingCycleId, mode, includeDraftSubmissions = false, userId, params = {}, legacyMode = false }) {
  // Create pending run document
  const run = await AlgorithmRun.create({
    cohortId,
    schedulingCycleId,
    mode,
    status: 'pending',
    createdBy: userId,
    parameters: {
      blockLengthMinutes: params.blockLengthMinutes ?? DEFAULT_BLOCK,
      stepMinutes:        params.stepMinutes        ?? DEFAULT_STEP,
      gridStartMinutes:   params.gridStartMinutes   ?? DEFAULT_START,
      gridEndMinutes:     params.gridEndMinutes      ?? DEFAULT_END,
      weekdays:           params.weekdays            ?? WEEKDAYS,
      timezone:           'America/Chicago',
      includeDraftSubmissions,
      legacyMode,
      solverVersion:  legacyMode ? 'legacy' : SOLVER_VERSION,
      maxSearchNodes: MAX_SEARCH_NODES,
      maxSearchMs:    params.maxSearchMs ?? DEFAULT_MAX_SEARCH_MS,
    },
  });

  const runWarnings = [];
  try {
    run.status    = 'running';
    run.startedAt = new Date();
    await run.save();

    // Build input
    const input = await buildAlgorithmInput({ cohortId, schedulingCycleId, mode, includeDraftSubmissions });
    runWarnings.push(...input.warnings);
    run.parameters.termCode = input.termCode;

    // Fetch sections
    const secResult = await fetchSectionsForAlgorithm(input.termCode, input.uniqueCodes);
    runWarnings.push(...secResult.warnings);

    // Resolve per-request allowed options (applies preferred section constraints
    // for req+pref mode; no-ops for required_only).
    const resolveWarnings = resolveRequestAllowedOptions(input.students, secResult.sectionsByCode);
    runWarnings.push(...resolveWarnings);

    // Build per-request constraint summary (static for this run — used for
    // transparency/debug; does not change per window).
    const requestConstraintSummary = input.students.flatMap((s) =>
      s.requests.map((req) => ({
        studentName:           s.name,
        courseCode:            req.code.toUpperCase().trim(),
        allOptionsCount:       req.allOptions?.length ?? 0,
        preferredOptionsCount: req.preferredOptions?.length ?? 0,
        allowedOptionsCount:   req.allowedOptions?.length ?? 0,
        constraintMode:        req.constraintMode ?? 'all',
      }))
    );

    // Generate candidate windows
    const windows = generateCandidateWindows(run.parameters);

    // Evaluate every window
    const rawResults = windows.map((win) =>
      evaluateWindow(win, input.students, secResult.sectionsByCode, legacyMode)
    );

    // Rank
    const rankedWindows = rankWindows(rawResults, legacyMode);

    // Preferred hard-conflict impact — informational, does not change ranking.
    // Required tier: shows preferred courses that would become impossible.
    // Preferred tier: the UI surfaces only the section-preference (narrowing) part.
    // Sections-Preferred needs none of this — its restricted-student detail comes
    // from the main conflict/blocked results (see restrictedStudentSections).
    let finalWindows = rankedWindows;
    if (mode === 'required_only' || mode === 'preferred') {
      const prefResult = await computePreferredHardConflictImpact({
        rankedWindows,
        cohortId,
        schedulingCycleId,
        allMappedRows: secResult.allMappedRows,
        legacyMode,
      });
      finalWindows = prefResult.windows;
      runWarnings.push(...prefResult.warnings);
    }

    // Heatmap (based on required-only scores; preferredHardConflictImpact is supplemental data)
    const heatmap = buildHeatmap(finalWindows, legacyMode);

    // Summary
    const best = finalWindows[0] ?? null;
    const summary = {
      totalStudents:          input.students.length,
      totalCourseRequests:    input.totalRequests,
      totalUniqueCourses:     input.uniqueCodes.length,
      bestConflictRequests:     best?.conflictRequests    ?? null,
      bestAffectedStudents:     best?.affectedStudents    ?? null,
      bestSelfConflictStudents: legacyMode ? null : (best?.selfConflictStudents ?? null),
      bestBlockedRequests:     best?.blockedRequests     ?? null,
      bestWindowsCount:        finalWindows.length,
      legacyMode,
    };

    // Save results
    run.status      = 'completed';
    run.completedAt = new Date();
    run.summary     = summary;
    run.warnings    = runWarnings;
    run.results     = {
      windows:              finalWindows,
      heatmap,
      courseSectionSummary: secResult.courseSectionSummary,
      unavailableCourses:   secResult.unavailableCourses,
      requestConstraintSummary,
    };
    await run.save();
    console.log(`[algorithm retention] saved run id=${run._id} mode=${run.mode}`);

    return run;
  } catch (err) {
    run.status       = 'failed';
    run.completedAt  = new Date();
    run.errorMessage = err.message;
    run.warnings     = runWarnings;
    await run.save();
    console.log(`[algorithm retention] saved run id=${run._id} mode=${run.mode} status=failed`);
    try {
      await pruneAlgorithmRunsGlobal({ limit: 12, reason: 'failed-run' });
    } catch (cleanupErr) {
      console.error('[algorithm retention] cleanup error after failed run (non-fatal):', cleanupErr);
    }
    throw err;
  }
}

/**
 * Run all three tiers (Required, Preferred, Sections-Preferred) in parallel.
 * Returns { requiredOnlyRun, preferredRun, requiredPlusPreferredRun }.
 */
async function runAllZlpModes({ cohortId, schedulingCycleId, includeDraftSubmissions = false, userId, params = {}, legacyMode = false }) {
  const [requiredOnlyRun, preferredRun, requiredPlusPreferredRun] = await Promise.all([
    runZlpAlgorithmForCycle({ cohortId, schedulingCycleId, mode: 'required_only',           includeDraftSubmissions, userId, params, legacyMode }),
    runZlpAlgorithmForCycle({ cohortId, schedulingCycleId, mode: 'preferred',                includeDraftSubmissions, userId, params, legacyMode }),
    runZlpAlgorithmForCycle({ cohortId, schedulingCycleId, mode: 'required_plus_preferred', includeDraftSubmissions, userId, params, legacyMode }),
  ]);
  // Single cleanup after all modes complete — avoids the parallel-execution
  // race where simultaneous per-mode cleanups each see the same docs to delete
  // and one ends up a no-op, leaving the count too high. 12 = last 4 runs x 3 modes.
  try {
    await pruneAlgorithmRunsGlobal({ limit: 12, reason: 'post-run' });
  } catch (cleanupErr) {
    console.error('[algorithm retention] cleanup error after runAllZlpModes (non-fatal):', cleanupErr);
  }
  return { requiredOnlyRun, preferredRun, requiredPlusPreferredRun };
}

// ---------------------------------------------------------------------------
// Window grouping (contiguous same-score ranges on the same day)
// ---------------------------------------------------------------------------

/**
 * Group ranked windows into contiguous ranges with the same conflictRequests score
 * on the same day, given a fixed step size.
 *
 * e.g. if M 08:00, M 08:05, M 08:10 all have score 0, they become one group:
 *   startRangeStr = "08:00–08:10", endRangeStr = "09:40–09:50", rangeLength = 3
 *
 * Returns groups sorted by (score ASC, day order, startMinutes ASC).
 */
function groupContiguousWindows(rankedWindows, step = 5) {
  const DAY_ORDER = { M: 0, T: 1, W: 2, R: 3, F: 4 };

  // Partition windows by day
  const byDay = {};
  for (const w of rankedWindows) {
    if (!byDay[w.day]) byDay[w.day] = [];
    byDay[w.day].push(w);
  }

  const groups = [];
  for (const day of WEEKDAYS) {
    const wins = byDay[day];
    if (!wins || wins.length === 0) continue;

    // Sort by start time within day
    wins.sort((a, b) => a.startMinutes - b.startMinutes);

    let i = 0;
    while (i < wins.length) {
      const totalHard = wins[i].totalHardConflicts ?? wins[i].conflictRequests;
      let j = i;
      // Extend the run while totalHardConflicts is equal and starts are exactly one step apart
      while (
        j + 1 < wins.length &&
        (wins[j + 1].totalHardConflicts ?? wins[j + 1].conflictRequests) === totalHard &&
        wins[j + 1].startMinutes === wins[j].startMinutes + step
      ) {
        j++;
      }
      const score = wins[i].conflictRequests; // kept for compat
      const first = wins[i];
      const last  = wins[j];
      groups.push({
        ...first, // spread first window's fields (conflicts, blocked, students, etc.)
        startRangeStr: first.startTime === last.startTime
          ? first.startTime
          : `${first.startTime}–${last.startTime}`,
        endRangeStr: first.endTime === last.endTime
          ? first.endTime
          : `${first.endTime}–${last.endTime}`,
        rangeLength: j - i + 1,
        score,
      });
      i = j + 1;
    }
  }

  // Sort groups by totalHardConflicts ASC (fall back to conflictRequests), then day, then start
  groups.sort((a, b) => {
    const tA = a.totalHardConflicts ?? a.conflictRequests ?? 0;
    const tB = b.totalHardConflicts ?? b.conflictRequests ?? 0;
    if (tA !== tB) return tA - tB;
    const dOrd = (DAY_ORDER[a.day] ?? 9) - (DAY_ORDER[b.day] ?? 9);
    if (dOrd !== 0) return dOrd;
    return a.startMinutes - b.startMinutes;
  });

  return groups;
}

// ---------------------------------------------------------------------------
// Excel export
// ---------------------------------------------------------------------------

/**
 * Build an ExcelJS workbook for one algorithm run.
 * @param {object} run  AlgorithmRun document (with results populated)
 * @returns {Promise<ExcelJS.Workbook>}
 */
async function buildExcelWorkbook(run) {
  console.log('[buildExcelWorkbook] BUILD_EXCEL_WORKBOOK_VERSION_TOTAL_HARD_V2 runId=%s', run._id);
  let ExcelJS;
  try { ExcelJS = require('exceljs'); } catch {
    throw new Error('exceljs is not installed. Run: npm install exceljs');
  }

  const wb = new ExcelJS.Workbook();
  wb.creator  = 'ZLP Scheduler';
  wb.created  = new Date();
  wb.modified = new Date();

  const { windows = [], heatmap = {}, courseSectionSummary = [], unavailableCourses = [] } = run.results ?? {};
  const modeName = run.mode === 'required_only' ? 'Required'
                 : run.mode === 'preferred'     ? 'Preferred'
                 : 'Sections-Preferred';
  const legacyMode = run.parameters?.legacyMode ?? false;

  // Section prefs affected — matches the website column: impact-pass count where
  // available (Required/Preferred), else the restricted students in the cards.
  const sectionPrefsAffectedCount = (win) => {
    if (win.preferredHardConflictImpact?.preferredRestrictedStudents != null) return win.preferredHardConflictImpact.preferredRestrictedStudents;
    const s = new Set();
    for (const c of (win.conflictCourses ?? [])) for (const n of (c.restrictedStudentNames ?? [])) s.add(n);
    for (const c of (win.blockedCourses  ?? [])) for (const n of (c.restrictedStudentNames ?? [])) s.add(n);
    return s.size;
  };

  // Helper: parse HH:MM to minutes for sorting
  const toMin24 = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

  // ─── Group contiguous windows ─────────────────────────────────────────────
  const step = run.parameters?.stepMinutes ?? DEFAULT_STEP;
  const allGroups = groupContiguousWindows(windows, step);

  // Select groups for ranked table: all with score <= 2, fill to at least 10
  const lowScoreGroups  = allGroups.filter((g) => g.score <= 2);
  const highScoreGroups = allGroups.filter((g) => g.score > 2);
  const selectedGroups  = lowScoreGroups.length >= 10
    ? lowScoreGroups
    : [...lowScoreGroups, ...highScoreGroups.slice(0, 10 - lowScoreGroups.length)];
  selectedGroups.forEach((g, i) => { g.groupRank = i + 1; });

  // ─── Sheet 1: ZLP Schedule (Heatmap left, Ranked groups right) ───────────
  const mainSheet = wb.addWorksheet('ZLP Schedule');

  // Column widths
  // Left: A(1)=StartTime B(2)=M C(3)=T D(4)=W E(5)=R F(6)=F G(7)=gap
  // Right: H(8)+ = ranked grouped table
  mainSheet.getColumn(1).width = 12; // Start Time
  mainSheet.getColumn(2).width = 8;  // M
  mainSheet.getColumn(3).width = 8;  // T
  mainSheet.getColumn(4).width = 8;  // W
  mainSheet.getColumn(5).width = 8;  // R
  mainSheet.getColumn(6).width = 8;  // F
  mainSheet.getColumn(7).width = 3;  // gap

  const RIGHT_START = 8; // column index (1-based) for first ranked-table column (H)
  const rightHeaders = [
    { name: 'Rank',                    width: 6  },
    { name: 'Day',                     width: 6  },
    { name: 'Start range',             width: 16 },
    { name: 'End range',               width: 16 },
    { name: 'Range length (starts)',   width: 22 },
    { name: 'Total Hard Conflicts',    width: 20 },
    { name: 'Direct Conflicts',        width: 18 },
    { name: 'Affected Students',       width: 18 },
    ...(!legacyMode ? [{ name: 'Self-Conflicts',              width: 18 }] : []),
    { name: 'Non-Lab Blocked Req',         width: 20 },
    { name: 'Blocked Requests',            width: 18 },
    { name: 'Block-Affected Students',     width: 20 },
    ...(!legacyMode ? [{ name: 'Unknown',                width: 12 }] : []),
    ...(run.mode === 'required_only' ? [
      { name: 'Pref. Hard Conflicts',    width: 22 },
      { name: 'Pref. Affected Students', width: 22 },
      { name: 'Pref. Unknown',           width: 14 },
    ] : []),
    { name: 'Conflicting Courses',     width: 44 },
    { name: 'Blocked Courses',         width: 44 },
    ...(!legacyMode ? [{ name: 'Self-Conflict Reasons',  width: 50 }] : []),
    { name: 'Sect.-Pref. Affected',  width: 20 },
  ];
  rightHeaders.forEach((col, i) => {
    mainSheet.getColumn(RIGHT_START + i).width = col.width;
  });

  // Freeze at B2 (left column + header row frozen)
  mainSheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];

  // Row 1: headers
  const headerRow = mainSheet.getRow(1);
  const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
  const headerData = [
    [1, 'Start Time'], [2, 'M'], [3, 'T'], [4, 'W'], [5, 'R'], [6, 'F'],
  ];
  for (const [col, label] of headerData) {
    const c = headerRow.getCell(col);
    c.value = label;
    c.font  = { bold: true };
    c.fill  = HEADER_FILL;
    c.alignment = { horizontal: 'center' };
  }
  rightHeaders.forEach((col, i) => {
    const c = headerRow.getCell(RIGHT_START + i);
    c.value = col.name;
    c.font  = { bold: true };
    c.fill  = HEADER_FILL;
  });

  // Helper: build ranked-group row values (column order must match rightHeaders)
  function groupRowVals(g) {
    const selfConflicts = g.selfConflictStudents ?? g.selfBlockedStudents ?? 0;
    const totalHard = legacyMode
      ? (g.conflictRequests ?? 0)
      : (g.totalHardConflicts ?? ((g.conflictRequests ?? 0) + selfConflicts));
    return [
      g.groupRank,
      g.dayLabel,
      g.startRangeStr,
      g.endRangeStr,
      g.rangeLength,
      totalHard,
      g.conflictRequests ?? 0,
      g.affectedStudents ?? 0,
      ...(!legacyMode ? [selfConflicts] : []),
      g.nonLabBlockedRequests ?? 0,
      g.blockedRequests ?? 0,
      g.blockedStudents ?? 0,
      ...(!legacyMode ? [g.feasibilityUnknownCount ?? g.feasibilityUnknownStudents?.length ?? 0] : []),
      ...(run.mode === 'required_only' ? (() => {
        const pref = g.preferredHardConflictImpact;
        return [
          pref?.preferredHardConflicts              ?? 0,
          pref?.preferredAffectedStudents           ?? 0,
          pref?.preferredFeasibilityUnknownStudents ?? 0,
        ];
      })() : []),
      (g.conflictCourses ?? []).map((c) => { const lbl = c.secondaryOnlyLabel ?? (c.labOnly ? 'Lab only' : null); return lbl ? `${c.code} (${lbl})` : c.code; }).join(', '),
      (g.blockedCourses ?? []).map((c) => { const lbl = c.secondaryOnlyLabel ?? (c.labOnly ? 'Lab only' : null); return lbl ? `${c.code} (${lbl})` : c.code; }).join(', '),
      ...(!legacyMode ? [(g.selfConflictReasons ?? g.selfBlockReasons ?? []).map((r) => `${r.student}: ${r.reason}`).join('; ')] : []),
      sectionPrefsAffectedCount(g),
    ];
  }

  // Helper: interpolate two hex RGB colors by t ∈ [0,1]
  function lerpHex(hexA, hexB, t) {
    const rA = parseInt(hexA.slice(0, 2), 16), gA = parseInt(hexA.slice(2, 4), 16), bA = parseInt(hexA.slice(4, 6), 16);
    const rB = parseInt(hexB.slice(0, 2), 16), gB = parseInt(hexB.slice(2, 4), 16), bB = parseInt(hexB.slice(4, 6), 16);
    const r = Math.round(rA + (rB - rA) * t);
    const g = Math.round(gA + (gB - gA) * t);
    const b = Math.round(bA + (bB - bA) * t);
    return `FF${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`.toUpperCase();
  }
  // Green → Yellow → Red scale matching original Python spreadsheet (63BE7B / FFEB84 / F8696B)
  function heatmapArgb(value, maxValue) {
    if (value <= 0 || maxValue <= 0) return 'FF63BE7B';
    const ratio = Math.min(value / maxValue, 1);
    if (ratio <= 0.5) return lerpHex('63BE7B', 'FFEB84', ratio / 0.5);
    return lerpHex('FFEB84', 'F8696B', (ratio - 0.5) / 0.5);
  }

  // ─── Heatmap data rows ────────────────────────────────────────────────────
  const startTimes   = Object.keys(heatmap).sort((a, b) => toMin24(a) - toMin24(b));
  const maxConflict  = Math.max(1, ...windows.map((w) => w.totalHardConflicts ?? w.conflictRequests));
  const DAY_COLS     = { M: 2, T: 3, W: 4, R: 5, F: 6 }; // col index for each day

  startTimes.forEach((st, rowIdx) => {
    const dataRow = mainSheet.getRow(rowIdx + 2); // row 1 is header
    // Start time label
    const timeCell = dataRow.getCell(1);
    timeCell.value = st;
    timeCell.alignment = { horizontal: 'right' };

    // Heatmap day cells
    for (const [day, colIdx] of Object.entries(DAY_COLS)) {
      const cell = heatmap[st]?.[day];
      const exCell = dataRow.getCell(colIdx);
      if (cell) {
        const cellValue = cell.totalHardConflicts ?? cell.conflictRequests;
        exCell.value = cellValue;
        exCell.alignment = { horizontal: 'center' };
        exCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: heatmapArgb(cellValue, maxConflict) } };
      }
    }

    // Right side: ranked grouped windows (only while we have groups)
    if (rowIdx < selectedGroups.length) {
      const g = selectedGroups[rowIdx];
      groupRowVals(g).forEach((val, i) => { dataRow.getCell(RIGHT_START + i).value = val; });
    }
  });

  // If more groups than heatmap rows, append extra rows for remaining groups
  for (let gi = startTimes.length; gi < selectedGroups.length; gi++) {
    const extraRow = mainSheet.getRow(gi + 2);
    groupRowVals(selectedGroups[gi]).forEach((val, i) => { extraRow.getCell(RIGHT_START + i).value = val; });
  }

  // Mode info note on A1
  mainSheet.getCell('A1').note = run.mode === 'required_plus_preferred'
    ? `Mode: ${modeName}\nPreferred sections constrain each student's allowed sections.`
    : `Mode: ${modeName}\nAll sections open — preferred sections do not constrain scoring here.`;

  // ─── Sheet 2: Course Summary ───────────────────────────────────────────────
  const csSheet = wb.addWorksheet('Course Summary');
  csSheet.columns = [
    { header: 'Course',          key: 'code',     width: 14 },
    { header: 'Sections Found',  key: 'sections', width: 16 },
    { header: 'Status',          key: 'status',   width: 14 },
    { header: 'Note',            key: 'note',     width: 50 },
  ];
  csSheet.getRow(1).font = { bold: true };
  for (const c of courseSectionSummary) {
    csSheet.addRow({
      code:     c.code,
      sections: c.sectionsFound,
      status:   c.status,
      note:     unavailableCourses.includes(c.code)
        ? 'No section data — excluded from feasibility scoring'
        : '',
    });
  }

  // ─── Sheet 3: All Windows (individual, unfiltered) ────────────────────────
  const rwSheet = wb.addWorksheet('All Windows');
  rwSheet.columns = [
    { header: 'Rank',                    key: 'rank',               width: 6  },
    { header: 'Day',                     key: 'dayLabel',           width: 6  },
    { header: 'Start',                   key: 'startTime',          width: 10 },
    { header: 'End',                     key: 'endTime',            width: 10 },
    { header: 'Total Hard Conflicts',    key: 'totalHardConflicts',    width: 20 },
    { header: 'Direct Conflicts',         key: 'conflictRequests',      width: 18 },
    { header: 'Affected Students',        key: 'affectedStudents',      width: 18 },
    ...(!legacyMode ? [{ header: 'Self-Conflicts',         key: 'selfConflictStudents',  width: 18 }] : []),
    { header: 'Non-Lab Blocked Req',       key: 'nonLabBlockedRequests', width: 20 },
    { header: 'Blocked Requests',         key: 'blockedRequests',       width: 18 },
    { header: 'Block-Affected Students',  key: 'blockedStudents',       width: 20 },
    ...(!legacyMode ? [
      { header: 'Unknown',               key: 'feasibilityUnknownCount', width: 14 },
    ] : []),
    { header: 'Conflicting Courses',     key: 'conflictCoursesList', width: 44 },
    { header: '# Blocked Courses',       key: 'numBlockedCourses',  width: 18 },
    { header: 'Blocked Courses',         key: 'blockedCoursesList', width: 44 },
    ...(!legacyMode ? [{ header: 'Self-Conflict Reasons', key: 'selfConflictReasons', width: 50 }] : []),
    ...(run.mode === 'required_only' ? [
      { header: 'Pref. Hard Conflicts',    key: 'prefHardConflicts',    width: 22 },
      { header: 'Pref. Affected Students', key: 'prefAffectedStudents', width: 22 },
      { header: 'Pref. Direct Conflicts',  key: 'prefDirectConflicts',  width: 22 },
      { header: 'Pref. Self-Conflicts',    key: 'prefSelfConflicts',    width: 20 },
      { header: 'Pref. Unknown',           key: 'prefUnknown',          width: 16 },
    ] : []),
    { header: 'Sect.-Pref. Affected',  key: 'sectionPrefsAffected', width: 20 },
  ];
  rwSheet.getRow(1).font = { bold: true };
  rwSheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const w of windows) {
    const row = {
      rank:                w.rank,
      dayLabel:            w.dayLabel,
      startTime:           w.startTime,
      endTime:             w.endTime,
      totalHardConflicts:  w.totalHardConflicts ?? ((w.conflictRequests ?? 0) + (w.selfConflictStudents ?? w.selfBlockedStudents ?? 0)),
      conflictRequests:    w.conflictRequests   ?? 0,
      affectedStudents:    w.affectedStudents   ?? 0,
      nonLabBlockedRequests: w.nonLabBlockedRequests ?? 0,
      blockedRequests:     w.blockedRequests    ?? 0,
      blockedStudents:     w.blockedStudents    ?? 0,
      conflictCoursesList: (w.conflictCourses ?? []).map((c) => { const lbl = c.secondaryOnlyLabel ?? (c.labOnly ? 'Lab only' : null); return lbl ? `${c.code} (${lbl})` : c.code; }).join(', '),
      numBlockedCourses:   w.uniqueBlockedCourseCount ?? 0,
      blockedCoursesList:  (w.blockedCourses ?? []).map((c) => { const lbl = c.secondaryOnlyLabel ?? (c.labOnly ? 'Lab only' : null); return lbl ? `${c.code} (${lbl})` : c.code; }).join(', '),
    };
    if (!legacyMode) {
      row.selfConflictStudents     = w.selfConflictStudents ?? w.selfBlockedStudents ?? 0;
      row.feasibilityUnknownCount  = w.feasibilityUnknownCount ?? w.feasibilityUnknownStudents?.length ?? 0;
      row.selfConflictReasons      = (w.selfConflictReasons ?? w.selfBlockReasons ?? []).map((r) => `${r.student}: ${r.reason}`).join('; ');
    }
    if (run.mode === 'required_only') {
      const pref = w.preferredHardConflictImpact;
      row.prefHardConflicts    = pref?.preferredHardConflicts              ?? 0;
      row.prefAffectedStudents = pref?.preferredAffectedStudents           ?? 0;
      row.prefDirectConflicts  = pref?.preferredDirectConflictRequests     ?? 0;
      row.prefSelfConflicts    = pref?.preferredSelfConflictStudents       ?? 0;
      row.prefUnknown          = pref?.preferredFeasibilityUnknownStudents ?? 0;
    }
    row.sectionPrefsAffected = sectionPrefsAffectedCount(w);
    rwSheet.addRow(row);
  }

  // ─── Meta sheet (version marker) ─────────────────────────────────────────
  const metaSheet = wb.addWorksheet('Export Info');
  metaSheet.getColumn(1).width = 28;
  metaSheet.getColumn(2).width = 40;
  [
    ['Export version',  'total-hard-v2'],
    ['Run ID',          String(run._id)],
    ['Mode',            modeName],
    ['Generated at',    new Date().toISOString()],
    ['Legacy Python Mode', legacyMode ? 'Yes' : 'No'],
    ['Self-conflict checks', legacyMode ? 'Skipped' : 'Enabled'],
    ['Color scale',     'Green #63BE7B → Yellow #FFEB84 → Red #F8696B'],
    ['Heatmap metric',  legacyMode ? 'Direct Conflicts only (self-conflict skipped)' : 'Total Hard Conflicts (Direct + Self-Conflicts)'],
  ].forEach(([k, v]) => {
    const r = metaSheet.addRow([k, v]);
    r.getCell(1).font = { bold: true };
  });

  return wb;
}

// ---------------------------------------------------------------------------
// Diagnostic helper
// ---------------------------------------------------------------------------

/**
 * Build a comprehensive diagnostic report without running the algorithm.
 * Useful for verifying data integrity before an algorithm run.
 */
async function buildAlgorithmDiagnostic({ cohortId, schedulingCycleId }) {
  const warnings = [];
  const SectionPreference = require('../models/SectionPreference');

  // --- Cohort ---
  const cohort = await Cohort.findById(cohortId).lean();
  if (!cohort) throw new Error('Cohort not found.');

  // --- Cycle ---
  const cycle = await SchedulingCycle.findById(schedulingCycleId).lean();
  if (!cycle) throw new Error('Scheduling cycle not found.');
  if (String(cycle.cohortId) !== String(cohortId)) throw new Error('Cycle does not belong to this cohort.');

  // --- Members & submissions ---
  const members = await CohortMember.find({ cohortId, status: 'active' }).lean();
  const memberUserIds = members.map((m) => m.userId);

  const allSubmissions = await require('../models/StudentSubmission').find(
    { schedulingCycleId, userId: { $in: memberUserIds } }
  ).lean();

  const submittedIds = new Set(
    allSubmissions.filter((s) => s.status === 'submitted').map((s) => String(s.userId))
  );

  // --- Users ---
  const users = await User.find({ _id: { $in: memberUserIds } }, { name: 1, email: 1 }).lean();
  const userMap = new Map(users.map((u) => [String(u._id), u]));

  // --- All course requests for this cycle for active members ---
  const allRequests = await StudentCourseRequest.find({
    schedulingCycleId,
    userId: { $in: memberUserIds },
  }).lean();

  const reqWithMeta = allRequests.map((r) => {
    const uid = String(r.userId);
    const u   = userMap.get(uid);
    const sub = allSubmissions.find((s) => String(s.userId) === uid);
    return {
      studentName:   u?.name  ?? uid,
      studentEmail:  u?.email ?? uid,
      code:          r.code,
      subject:       r.subject,
      number:        r.number,
      title:         r.title,
      systemClassification: r.systemClassification,
      finalClassification:  r.finalClassification,
      overrideStatus:       r.overrideStatus,
      submissionStatus:     sub?.status ?? 'none',
      includedInRequiredOnly:        r.finalClassification === 'required' && submittedIds.has(uid),
      includedInRequiredPlusPreferred: ['required', 'preferred'].includes(r.finalClassification) && submittedIds.has(uid),
    };
  });

  // --- Counts ---
  const requiredOnlyIncluded      = reqWithMeta.filter((r) => r.includedInRequiredOnly);
  const reqPlusPrefIncluded       = reqWithMeta.filter((r) => r.includedInRequiredPlusPreferred);
  const uniqueCodesReqOnly        = [...new Set(requiredOnlyIncluded.map((r) => r.code.toUpperCase().trim()))];
  const uniqueCodesReqPlusPreferred = [...new Set(reqPlusPrefIncluded.map((r) => r.code.toUpperCase().trim()))];

  // --- Section lookup for both unique code sets ---
  const allUniqueCodes = [...new Set([...uniqueCodesReqOnly, ...uniqueCodesReqPlusPreferred])];

  const termCode = cycle.termCode;
  let allMappedRows = [];
  let totalRawRows  = 0;
  let sectionFetchError = null;
  try {
    const rawRows  = await fetchSectionsForTerm(termCode);
    totalRawRows   = Array.isArray(rawRows) ? rawRows.length : 0;
    allMappedRows  = totalRawRows > 0 ? rawRows.map(mapSectionRow) : [];
  } catch (err) {
    sectionFetchError = err.message;
    warnings.push(`Failed to fetch sections from Howdy: ${err.message}`);
  }

  const subjectsInTerm   = new Set(allMappedRows.map((r) => r.subject.toUpperCase()));
  const subjectCounts    = {};
  for (const r of allMappedRows) {
    const s = r.subject.toUpperCase();
    subjectCounts[s] = (subjectCounts[s] ?? 0) + 1;
  }
  const allCodesInTerm   = new Set(allMappedRows.map((r) => `${r.subject} ${r.courseNumber}`.toUpperCase().trim()));

  // Normalize sections for all unique codes
  const sectionsByCode = normalizeSectionOptions(allMappedRows, allUniqueCodes);

  // Per-code section lookup diagnostics
  const sectionLookup = allUniqueCodes.map((code) => {
    const normCode  = code.toUpperCase().trim();
    const [subj, courseNum] = normCode.split(' ');
    const opts      = sectionsByCode[normCode] ?? [];
    const rawForCode = allMappedRows.filter((r) =>
      r.subject.toUpperCase() === subj && r.courseNumber === courseNum
    );

    let matchStatus;
    if (totalRawRows === 0) {
      matchStatus = 'no_term_data';
    } else if (!subjectsInTerm.has(subj)) {
      matchStatus = 'subject_not_in_term';
    } else if (!allCodesInTerm.has(normCode)) {
      matchStatus = 'course_not_offered';
    } else if (rawForCode.length > 0 && opts.length === 0) {
      matchStatus = 'rows_exist_no_meeting_times';
    } else if (opts.length > 0) {
      matchStatus = 'found';
    } else {
      matchStatus = 'not_found';
    }

    return {
      code:                   normCode,
      subject:                subj,
      number:                 courseNum,
      termCode,
      rawSectionsFound:       rawForCode.length,
      normalizedOptionsFound: opts.length,
      sampleRawRows:          rawForCode.slice(0, 3).map((r) => ({
        crn: r.crn, subject: r.subject, courseNumber: r.courseNumber,
        section: r.section, title: r.title,
        meetings: r.meetings,
      })),
      sampleNormalizedOptions: opts.slice(0, 2).map((o) => ({
        crn: o.crn, section: o.section, hasScheduledMeetings: o.hasScheduledMeetings,
        meetings: o.meetings,
      })),
      matchStatus,
    };
  });

  // --- Grid diagnostics ---
  const gridStart  = DEFAULT_START;
  const gridEnd    = DEFAULT_END;
  const block      = DEFAULT_BLOCK;
  const step       = DEFAULT_STEP;
  const startsPerDay = Math.floor((gridEnd - gridStart) / step) + 1;
  const weekdaysCount = WEEKDAYS.length;
  const expectedWindows = startsPerDay * weekdaysCount;
  const actualWindows   = generateCandidateWindows().length;

  // --- Preferred sections ---
  const preferredSections = await SectionPreference.find({
    schedulingCycleId,
    userId: { $in: memberUserIds },
  }).lean();

  return {
    cohort: { _id: cohort._id, name: cohort.name, status: cohort.status },
    cycle: {
      _id:        cycle._id,
      name:       cycle.name,
      termLabel:  cycle.term,
      termCode,
      status:     cycle.status,
      opensAt:    cycle.submissionOpenAt,
      deadline:   cycle.submissionDeadline,
    },
    counts: {
      cohortMembers:                 members.length,
      submissions:                   allSubmissions.length,
      submittedSubmissions:          submittedIds.size,
      courseRequestsTotal:           allRequests.length,
      requiredOnlyIncluded:          requiredOnlyIncluded.length,
      requiredPlusPreferredIncluded: reqPlusPrefIncluded.length,
      uniqueCoursesRequiredOnly:     uniqueCodesReqOnly.length,
      uniqueCoursesRequiredPlusPreferred: uniqueCodesReqPlusPreferred.length,
    },
    courseRequests: reqWithMeta,
    sectionLookup,
    termSectionStats: {
      termCode,
      totalRawRowsFromHowdy:  totalRawRows,
      sectionFetchError,
      subjectsPresent:        [...subjectsInTerm].sort(),
      subjectCounts,
    },
    algorithmGrid: {
      gridStart:        formatTime24h(gridStart),
      gridEnd:          formatTime24h(gridEnd),
      gridStartMinutes: gridStart,
      gridEndMinutes:   gridEnd,
      blockLengthMinutes: block,
      stepMinutes:       step,
      startsCount:       startsPerDay,
      weekdaysCount,
      expectedWindows,
      actualWindows,
      firstStart: formatTime24h(gridStart),
      lastStart:  formatTime24h(gridEnd),
    },
    preferredSections: {
      savedCount:                  preferredSections.length,
      usedInRequiredOnly:          false,
      usedInPreferred:             false,
      usedInRequiredPlusPreferred: true,
      note: 'Preferred sections constrain the allowed option pool only in the Sections-Preferred tier. In the Required and Preferred tiers all available sections are used, so preferred sections have no effect on scoring there.',
      samples: preferredSections.slice(0, 5).map((p) => ({
        userId:          String(p.userId),
        crn:             p.crn,
        section:         p.section,
        instructorLabel: p.instructorLabel,
      })),
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Per-window per-student debug
// ---------------------------------------------------------------------------

/**
 * Re-evaluate one specific ZLP window with full per-student debug output.
 * Shows surviving options, dedup counts, DFS results, and why students hit
 * the search limit.
 *
 * @param {{ cohortId, schedulingCycleId, mode, day, startMinutes }} opts
 */
async function buildWindowDebug({ cohortId, schedulingCycleId, mode = 'required_only', day, startMinutes }) {
  const endMinutes = startMinutes + DEFAULT_BLOCK;

  const input = await buildAlgorithmInput({
    cohortId, schedulingCycleId, mode, includeDraftSubmissions: false,
  });
  const secResult   = await fetchSectionsForAlgorithm(input.termCode, input.uniqueCodes);
  const resolveWarnings = resolveRequestAllowedOptions(input.students, secResult.sectionsByCode);

  const studentDebug = [];

  for (const student of input.students) {
    const reqDebug  = [];
    const survivingForCheck = {};

    for (const req of student.requests) {
      const code    = req.code.toUpperCase().trim();
      const options = req.allowedOptions ?? secResult.sectionsByCode[code] ?? [];

      const overlapping  = options.filter((o) => optionOverlapsZlpBlock(o, day, startMinutes, endMinutes));
      const surviving    = options.filter((o) => !optionOverlapsZlpBlock(o, day, startMinutes, endMinutes));
      const asyncOpts    = options.filter((o) => !o.hasScheduledMeetings);
      const effective    = surviving.length > 0 ? surviving : asyncOpts;

      const isDirectConflict = options.length > 0 && overlapping.length === options.length && asyncOpts.length === 0;
      const isBlocked        = overlapping.length > 0 && effective.length > 0;

      // Primary group analysis (before and after ZLP filter)
      const { primaryGroups: pgBefore } = buildPrimarySchedulingGroups(options);
      const { primaryGroups: pgAfter  } = buildPrimarySchedulingGroups(effective);

      // Sample deduped patterns from surviving options
      const seenSigs = new Set();
      const deduped  = effective.filter((opt) => {
        const sig = meetingSignature(opt);
        if (seenSigs.has(sig)) return false;
        seenSigs.add(sig);
        return true;
      });

      if (!isDirectConflict && effective.length > 0) {
        survivingForCheck[code] = effective;
      }

      reqDebug.push({
        code,
        title:                        req.title,
        classification:               req.classification,
        constraintMode:               req.constraintMode ?? 'all',
        allOptionsCount:              options.length,
        overlappingCount:             overlapping.length,
        survivingOptionsCount:        effective.length,
        dedupedSurvivingOptionsCount: deduped.length,
        primaryGroupsBeforeZlp:       pgBefore.length,
        primaryGroupsAfterZlp:        pgAfter.length,
        primaryGroupSignatures:       pgAfter.map((g) => g.sig).slice(0, 8),
        directConflict:               isDirectConflict,
        blocked:                      isBlocked,
        constrainedForSelfConflict:   pgAfter.length > 0 && pgAfter.length < 3,
        sampleSurvivingCRNs:          effective.slice(0, 5).map((o) => o.crn),
      });
    }

    // Decide whether to run the self-conflict check (same logic as evaluateStudentFeasibilityForWindow)
    const checkDecision = shouldRunSelfConflictCheck(survivingForCheck);
    let selfConflictStatus;
    let combo = null;

    if (Object.keys(survivingForCheck).length === 0) {
      selfConflictStatus = 'no_surviving_options';
    } else if (!checkDecision.shouldCheck) {
      selfConflictStatus = 'skipped_low_risk';
    } else {
      combo = findFeasibleScheduleCombination(survivingForCheck);
      selfConflictStatus =
        combo.selfConflict ? 'self_conflict_exact' :
        combo.unknown      ? 'unknown_timeout'      :
                             'feasible_exact';
    }

    const STATUS_LABELS = {
      feasible_exact:       'Feasible — checked',
      self_conflict_exact:  'Self-conflict',
      skipped_low_risk:     'Low-risk — heuristic skip',
      unknown_timeout:      'Unknown — solver limit reached',
      no_surviving_options: 'Feasible (no courses need checking)',
    };

    const primaryGroupsAfterZlpPerCourse = Object.fromEntries(
      reqDebug.filter((r) => !r.directConflict).map((r) => [r.code, r.primaryGroupsAfterZlp])
    );

    const reason = selfConflictStatus === 'skipped_low_risk'
      ? `Low-risk heuristic skip: all included courses had ${checkDecision.constrainedCourses.length === 0
          ? 'more than 2'
          : 'enough'} primary meeting-time options after the ZLP filter. Self-conflict is not expected; no DFS was run.`
      : selfConflictStatus === 'unknown_timeout'
      ? `Solver limit reached after ${combo?.searchNodes ?? '?'} nodes (cap: ${combo?.searchLimit ?? MAX_SEARCH_NODES}). Feasibility could not be determined exactly.`
      : selfConflictStatus === 'self_conflict_exact'
      ? 'No valid primary-schedule combination found after removing ZLP-conflicting sections (proven infeasible by DFS over lecture-time groups).'
      : selfConflictStatus === 'feasible_exact'
      ? 'Feasible — DFS over primary meeting-time groups found a valid non-conflicting combination.'
      : 'No surviving courses required a self-conflict check.';

    studentDebug.push({
      studentName:          student.name,
      studentId:            student.userId,
      requests:             reqDebug,
      directConflicts:      reqDebug.filter((r) => r.directConflict).map((r) => r.code),
      blockedCourses:       reqDebug.filter((r) => r.blocked).map((r) => r.code),
      survivingCoursesForCheck: Object.keys(survivingForCheck),
      dfsCourseCount:       Object.keys(survivingForCheck).length,
      primaryGroupsAfterZlpPerCourse,
      constrainedCourses:   checkDecision.constrainedCourses,
      selfConflictCheckReason: checkDecision.reason,
      selfConflictStatus,
      selfConflictStatusLabel: STATUS_LABELS[selfConflictStatus] ?? selfConflictStatus,
      feasible:             selfConflictStatus !== 'self_conflict_exact',
      selfConflict:         selfConflictStatus === 'self_conflict_exact',
      feasibilityUnknown:   selfConflictStatus === 'unknown_timeout',
      searchNodesChecked:   combo?.searchNodes ?? 0,
      searchLimit:          combo?.searchLimit  ?? MAX_SEARCH_NODES,
      reason,
    });
  }

  return {
    window: {
      day,
      startMinutes,
      endMinutes,
      startTime: formatTime24h(startMinutes),
      endTime:   formatTime24h(endMinutes),
    },
    mode,
    termCode:       input.termCode,
    resolveWarnings,
    studentCount:   studentDebug.length,
    studentDebug,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  runZlpAlgorithmForCycle,
  runAllZlpModes,
  buildAlgorithmInput,
  fetchSectionsForAlgorithm,
  resolveRequestAllowedOptions,
  normalizeSectionOptions,
  generateCandidateWindows,
  evaluateWindow,
  evaluateStudentFeasibilityForWindow,
  findFeasibleScheduleCombination,
  meetingSignature,
  optionOverlapsOption,
  optionOverlapsZlpBlock,
  rankWindows,
  buildHeatmap,
  formatTime24h,
  groupContiguousWindows,
  buildExcelWorkbook,
  buildAlgorithmDiagnostic,
  buildWindowDebug,
  buildWindowCountDebug,
  parseHHMM,
};

// ---------------------------------------------------------------------------
// Window count debug — per-section overlap detail for one window
// ---------------------------------------------------------------------------

/**
 * Re-evaluate one specific ZLP window and return per-student, per-course,
 * per-section overlap detail.  Useful for answering "why does the algorithm
 * think window T 12:35–14:15 has 0 conflicts?"
 *
 * @param {object} params
 *   runId        — load cohortId / schedulingCycleId / mode from this run
 *   day          — "M" | "T" | "W" | "R" | "F"
 *   startMinutes — ZLP window start in minutes since midnight
 * @returns {object} debug report
 */
async function buildWindowCountDebug({ runId, day, startMinutes }) {
  const run = await AlgorithmRun.findById(runId).select(
    'cohortId schedulingCycleId mode parameters status'
  ).lean();
  if (!run) throw new Error(`AlgorithmRun ${runId} not found.`);

  const endMinutes = startMinutes + (run.parameters?.blockLengthMinutes ?? DEFAULT_BLOCK);
  const mode       = run.parameters?.mode ?? run.mode ?? 'required_only';
  const legacyMode = run.parameters?.legacyMode ?? false;

  const input     = await buildAlgorithmInput({ cohortId: run.cohortId, schedulingCycleId: run.schedulingCycleId, mode, includeDraftSubmissions: run.parameters?.includeDraftSubmissions ?? false });
  const secResult = await fetchSectionsForAlgorithm(input.termCode, input.uniqueCodes);
  resolveRequestAllowedOptions(input.students, secResult.sectionsByCode);

  const windowInfo = {
    day,
    startMinutes,
    endMinutes,
    formattedStart: formatTime24h(startMinutes),
    formattedEnd:   formatTime24h(endMinutes),
    blockDurationMinutes: endMinutes - startMinutes,
    runId: String(runId),
    mode,
    legacyMode,
    termCode: input.termCode,
    solverVersion: run.parameters?.solverVersion ?? null,
    runCreatedAt:  run.createdAt ?? null,
  };

  let totConflictRequests  = 0;
  let totBlockedRequests   = 0;
  let totAffectedStudents  = 0;
  let totBlockedStudents   = 0;
  let totSelfConflict      = 0;
  let totUnknown           = 0;

  const students = [];

  for (const student of input.students) {
    const courses = [];
    let studentHasConflict = false;
    let studentHasBlocked  = false;

    for (const req of student.requests) {
      const code    = req.code.toUpperCase().trim();
      const options = req.allowedOptions ?? secResult.sectionsByCode[code] ?? [];

      const allOptions = options.map((o) => {
        const meetingsOnDay = o.meetings.filter((m) => m.days.includes(day));
        const overlapsWin   = meetingsOnDay.some((m) => overlaps(m.startMin, m.endMin, startMinutes, endMinutes));
        const overlapReasons = meetingsOnDay.map((m) => {
          const doesOverlap = overlaps(m.startMin, m.endMin, startMinutes, endMinutes);
          return {
            days:        m.days,
            startMin:    m.startMin,
            endMin:      m.endMin,
            startFmt:    formatTime24h(m.startMin),
            endFmt:      formatTime24h(m.endMin),
            isLab:       m.isLab,
            meetingType: m.type,
            overlaps:    doesOverlap,
            reason: doesOverlap
              ? `Overlap: max(${formatTime24h(m.startMin)}, ${formatTime24h(startMinutes)}) < min(${formatTime24h(m.endMin)}, ${formatTime24h(endMinutes)})`
              : `No overlap: max(${formatTime24h(m.startMin)}, ${formatTime24h(startMinutes)}) >= min(${formatTime24h(m.endMin)}, ${formatTime24h(endMinutes)})`,
          };
        });

        const hasNonDayMeetings = o.meetings.some((m) => !m.days.includes(day));
        return {
          crn:             o.crn,
          section:         o.section,
          hasScheduled:    o.hasScheduledMeetings,
          meetingsOnDay:   overlapReasons,
          otherDays:       o.meetings.filter((m) => !m.days.includes(day)).map((m) => ({ days: m.days, startFmt: formatTime24h(m.startMin), endFmt: formatTime24h(m.endMin), isLab: m.isLab })),
          overlapsWindow:  overlapsWin,
        };
      });

      const asyncOpts    = options.filter((o) => !o.hasScheduledMeetings);
      const overlapping  = options.filter((o) =>  optionOverlapsZlpBlock(o, day, startMinutes, endMinutes));
      const surviving    = options.filter((o) => !optionOverlapsZlpBlock(o, day, startMinutes, endMinutes));
      const effective    = surviving.length > 0 ? surviving : asyncOpts;

      const isDirectConflict = options.length > 0 && overlapping.length === options.length && asyncOpts.length === 0;
      const isBlocked        = overlapping.length > 0 && effective.length > 0;

      let status;
      if (isDirectConflict)  { status = 'direct_conflict'; studentHasConflict = true; totConflictRequests++; }
      else if (isBlocked)    { status = 'blocked';         studentHasBlocked  = true; totBlockedRequests++; }
      else                   { status = 'clear'; }

      courses.push({
        code,
        title:                 req.title,
        finalClassification:   req.classification,
        constraintMode:        req.constraintMode ?? 'all',
        allowedOptionsCount:   options.length,
        overlappingOptionsCount: overlapping.length,
        clearOptionsCount:     effective.length,
        status,
        options: allOptions,
      });
    }

    if (studentHasConflict) totAffectedStudents++;
    if (studentHasBlocked)  totBlockedStudents++;

    // Run student-level feasibility
    const eval_ = evaluateStudentFeasibilityForWindow(student, secResult.sectionsByCode, day, startMinutes, endMinutes, legacyMode);
    if (eval_.selfConflict) totSelfConflict++;
    else if (eval_.unknown) totUnknown++;

    students.push({
      studentName: student.name,
      studentId:   student.userId,
      courses,
      directConflicts:  courses.filter((c) => c.status === 'direct_conflict').map((c) => c.code),
      blockedCourses:   courses.filter((c) => c.status === 'blocked').map((c) => c.code),
      selfConflictStatus: eval_.selfConflictStatus ?? null,
    });
  }

  return {
    window: windowInfo,
    students,
    totals: {
      conflictRequests:        totConflictRequests,
      affectedStudents:        totAffectedStudents,
      blockedRequests:         totBlockedRequests,
      blockedStudents:         totBlockedStudents,
      selfConflictStudents:    totSelfConflict,
      feasibilityUnknownStudents: totUnknown,
    },
    inputSummary: {
      studentCount:       input.students.length,
      courseCount:        input.uniqueCodes.length,
      courseCodes:        input.uniqueCodes,
      termCode:           input.termCode,
    },
    sectionParseNotes: {
      description: 'Section times parsed with parseHHMM. Howdy returns 12-hour "HH:MM AM/PM" strings.',
      samples: input.uniqueCodes.slice(0, 6).map((code) => {
        const opts = secResult.sectionsByCode[code] ?? [];
        return {
          code,
          sectionCount: opts.length,
          firstFewMeetings: opts.slice(0, 2).flatMap((o) =>
            o.meetings.slice(0, 2).map((m) => ({
              days: m.days,
              startMin: m.startMin,
              endMin:   m.endMin,
              startFmt: formatTime24h(m.startMin),
              endFmt:   formatTime24h(m.endMin),
            }))
          ),
        };
      }),
    },
  };
}
