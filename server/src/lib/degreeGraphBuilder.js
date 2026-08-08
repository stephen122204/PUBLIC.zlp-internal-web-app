'use strict';
/**
 * degreeGraphBuilder.js
 *
 * Builds or retrieves a DegreeRequirementGraph for a given programId.
 *
 * Strategy:
 *  1. Check in-memory cache (fastest).
 *  2. Check MongoDB (DegreeRequirementGraph model).
 *  3. Check server/data/degree-plans.json for a matching static plan.
 *  4. For catalog-major: IDs, attempt to scrape catalog.tamu.edu.
 *  5. If all fail, return a minimal empty graph with warnings.
 *
 * Adapted from reference/tamu-course-offering-history/lib/catalog-degree-plans.mjs
 * and reference/tamu-course-offering-history/public/planner-engine.js
 * (read-only reference — not modified).
 */

const path = require('path');
const fs = require('fs');
const DegreeRequirementGraph = require('../models/DegreeRequirementGraph');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CATALOG_BASE = 'https://catalog.tamu.edu';
const FETCH_TIMEOUT_MS = 20000;
const FETCH_RETRIES = 2;
const DEGREE_PLANS_PATH = path.join(__dirname, '../../data/degree-plans.json');
const GENERATED_GRAPHS_PATH = path.join(__dirname, '../../data/generated-degree-graphs.json');

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------
/** @type {Map<string, object>} programId → graph */
const memCache = new Map();
/** @type {Map<string, number>} programId → timestamp (ms) */
const memCacheTime = new Map();
const MEM_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getFromMemCache(programId) {
  const ts = memCacheTime.get(programId);
  if (!ts || Date.now() - ts > MEM_CACHE_TTL_MS) return null;
  return memCache.get(programId) ?? null;
}

function setMemCache(programId, graph) {
  memCache.set(programId, graph);
  memCacheTime.set(programId, Date.now());
}

function clearMemCache(programId) {
  memCache.delete(programId);
  memCacheTime.delete(programId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Retired / consolidated courses that should always resolve to their current
// equivalent everywhere in the degree graph (nodes, prereqs, coreqs, pools,
// section lookups). e.g. MATH 253 "Engineering Math III" was folded into
// MATH 251 — it has had no sections since Fall 2014, so any degree that still
// lists 253 should display and resolve as MATH 251.
const COURSE_CODE_ALIASES = {
  'MATH 253': 'MATH 251',
};
function aliasCourseCode(code) {
  return COURSE_CODE_ALIASES[code] ?? code;
}

function normalizeCourseCode(text) {
  const m = String(text ?? '').toUpperCase().trim().match(/\b([A-Z]{3,5})\s*(\d{3}[A-Z]?)\b/u);
  return m ? aliasCourseCode(`${m[1]} ${m[2]}`) : null;
}

function extractCourseCodes(text) {
  const seen = new Set();
  const results = [];
  const upper = String(text ?? '').toUpperCase();
  const re = /\b([A-Z]{3,5})\s*(\d{3}[A-Z]?)\b/gu;
  let m;
  while ((m = re.exec(upper)) !== null) {
    const code = aliasCourseCode(`${m[1]} ${m[2]}`);
    if (!seen.has(code)) { seen.add(code); results.push(code); }
  }
  return results;
}

/**
 * Like extractCourseCodes but also detects range descriptors like "MATH 407-499".
 * Returns { codes: string[], ranges: string[] }
 *   codes  — individual validated course codes (range lower-bounds excluded)
 *   ranges — display-only range strings like "MATH 407-499" (not real course codes)
 */
function extractCourseCodesAndRanges(htmlOrText) {
  const upper = String(htmlOrText ?? '').toUpperCase();
  const seenKeys   = new Set();
  const codes      = [];
  const ranges     = [];
  const rangeStarts = new Set(); // lower bounds of detected ranges — skip as standalone

  // Detect ranges first (e.g. MATH 407-499, CSCE 210-470, STAT 335-482)
  const rangeRe = /\b([A-Z]{3,5})\s*(\d{3}[A-Z]?)-(\d{3,4})\b/gu;
  let rm;
  while ((rm = rangeRe.exec(upper)) !== null) {
    const rangeStr  = `${rm[1]} ${rm[2]}-${rm[3]}`;
    const lowerCode = `${rm[1]} ${rm[2]}`;
    if (!seenKeys.has(rangeStr)) {
      seenKeys.add(rangeStr);
      ranges.push(rangeStr);
      rangeStarts.add(lowerCode);
    }
  }

  // Detect individual course codes, excluding range lower bounds
  const codeRe = /\b([A-Z]{3,5})\s*(\d{3}[A-Z]?)\b/gu;
  let cm;
  while ((cm = codeRe.exec(upper)) !== null) {
    const code = aliasCourseCode(`${cm[1]} ${cm[2]}`);
    if (rangeStarts.has(code)) continue; // part of a range — skip as standalone
    if (!seenKeys.has(code)) { seenKeys.add(code); codes.push(code); }
  }

  return { codes, ranges };
}

function stripTags(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/ /g, ' ')   // literal non-breaking space (TAMU catalog uses this in hours cells)
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(Number(c)))
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePrerequisiteEdges(rawText, toCourseCode) {
  if (!rawText) return [];
  const codes = extractCourseCodes(rawText);
  const edges = [];
  for (const from of codes) {
    if (from !== toCourseCode) {
      edges.push({ from, to: toCourseCode, type: 'prerequisite', rawText });
    }
  }
  return edges;
}

function parseCorequisiteEdges(rawText, toCourseCode) {
  if (!rawText) return [];
  const codes = extractCourseCodes(rawText);
  const edges = [];
  for (const from of codes) {
    if (from !== toCourseCode) {
      edges.push({ from, to: toCourseCode, type: 'corequisite', rawText });
    }
  }
  return edges;
}

function parseCreditHours(text) {
  const ms = [...String(text ?? '').matchAll(/\d+(?:\.\d+)?/g)].map((m) => parseFloat(m[0]));
  if (!ms.length) return 0;
  return Math.max(...ms);
}

/**
 * parsePlanTableFromHtml – port of the reference parsePlanTable.
 * Extracts course nodes with year/term-based column IDs from the sc_plangrid table.
 * Returns { graphNodes, requirementGroups, subjects }.
 */
function parsePlanTableFromHtml(html) {
  const graphNodes = [];
  const requirementGroups = [];
  const colSeqMap = new Map(); // "year::term" → sequential col index
  const summerColIds = new Set(); // column IDs that correspond to Summer terms
  let currentYear = 'Year I';
  let currentTerm = 'Fall';
  let nodeIdx = 0;
  let firstPlanYear = null;      // text of the first "plangridyear" row, to detect a missing freshman year

  function getColId() {
    const key = `${currentYear}::${currentTerm}`;
    if (!colSeqMap.has(key)) colSeqMap.set(key, colSeqMap.size);
    const colId = `col-${colSeqMap.get(key)}`;
    if (/summer/i.test(currentTerm)) summerColIds.add(colId);
    return colId;
  }

  const tableMatches = [...html.matchAll(/<table[^>]*class="sc_plangrid"[\s\S]*?<\/table>/gi)];
  for (const [tableHtml] of tableMatches) {
    const rows = [...tableHtml.matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/gi)];
    let pendingChoice = null;

    function flushPendingChoice() {
      if (!pendingChoice) return;
      const { title, hours, colId, allMatches, isHoursBased, requiredHours, pickCount } = pendingChoice;
      // Exact course codes (not range descriptors like "MATH 407-499")
      const exactCodes = allMatches.filter((m) => /^[A-Z]{3,5}\s\d{3}[A-Z]?$/.test(m));
      // Row-level alternatives captured during accumulation
      const rowAlts = pendingChoice.rowAlternatives ?? [];
      // A compound choice has ≥ 2 alternatives and at least one is a bundle
      const hasCompoundBundle = rowAlts.length >= 2 && rowAlts.some((alt) => alt.isBundle);

      if (allMatches.length === 0) {
        // Empty option list — just a named requirement slot
        if (hours > 0) {
          nodeIdx++;
          graphNodes.push({
            id: `placeholder-${nodeIdx}`,
            type: 'elective',
            column: colId,
            code: null,
            title: title.slice(0, 80),
            hours,
            requiredHours: requiredHours ?? null,
            matches: [],
            pickCount: pickCount ?? null,
            prereqs: [],
            coreqs: [],
            required: false,
          });
        } else {
          requirementGroups.push({ label: title.slice(0, 120), hours });
        }
      } else if (!isHoursBased && exactCodes.length >= 2 && (exactCodes.length <= 4 || hasCompoundBundle)) {
        // Small count-based choice group ("Select one of: A, B, C") → choice node.
        // When at least one row-alternative is a bundle (courses required together),
        // produce an exact_compound_choice node with an alternatives[] array so that
        // downstream evidence extraction and classification can reason about bundles
        // vs single-course alternatives independently.
        if (hasCompoundBundle) {
          nodeIdx++;
          graphNodes.push({
            id: `choice-${nodeIdx}`,
            type: 'choice',
            requirementSubtype: 'exact_compound_choice',
            column: colId,
            code: null,
            title,
            hours,
            requiredHours: null,
            matches: [...new Set(exactCodes)],
            options: [...new Set(exactCodes)],
            alternatives: rowAlts.map((alt) => ({
              type: alt.isBundle ? 'bundle' : 'single',
              courses: [...alt.courses],
              requiredTogether: alt.isBundle,
            })),
            pickCount: pickCount ?? 1,
            prereqs: [],
            coreqs: [],
            required: true,
          });
        } else {
          nodeIdx++;
          graphNodes.push({
            id: `choice-${nodeIdx}`,
            type: 'choice',
            column: colId,
            code: exactCodes.join(' / '),
            title,
            hours,
            requiredHours: null,
            matches: [...new Set(exactCodes)],
            options: [...new Set(exactCodes)],
            pickCount: pickCount ?? 1,
            prereqs: [],
            coreqs: [],
            required: true,
          });
        }
      } else {
        // Hours-based OR large count-based pool → flexible elective slot
        nodeIdx++;
        graphNodes.push({
          id: `pick-n-${nodeIdx}`,
          type: 'elective',
          column: colId,
          code: null,
          title,
          hours,
          requiredHours: requiredHours ?? null,
          matches: [...new Set(allMatches)],
          pickCount: pickCount ?? null,
          prereqs: [],
          coreqs: [],
          required: false,
        });
      }
      pendingChoice = null;
    }

    for (const [, attrs, rowHtml] of rows) {
      const cls = (attrs.match(/class="([^"]+)"/) ?? [])[1] ?? '';

      if (/plangridyear/.test(cls)) {
        flushPendingChoice();
        currentYear = stripTags(rowHtml);
        if (firstPlanYear === null) firstPlanYear = currentYear;
        continue;
      }
      if (/plangridterm/.test(cls)) {
        flushPendingChoice();
        const termCells = [...rowHtml.matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)];
        if (termCells[0]) currentTerm = stripTags(termCells[0][1]);
        continue;
      }
      if (/plangridsum|plangridtotal|plangridsub/.test(cls)) {
        flushPendingChoice();
        continue;
      }

      const cells = [...rowHtml.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi)].map(([, a, h]) => ({
        colspan: parseInt((a.match(/colspan="(\d+)"/) ?? [])[1] ?? '1', 10),
        html: h,
        text: stripTags(h),
      }));

      if (cells.length < 2) continue;

      const codeCell = cells[0];
      const titleCell = cells[1] ?? cells[0];
      const hoursCell = cells[cells.length - 1];
      const hours = parseCreditHours(hoursCell.text);
      const codeText = codeCell.text;
      const codeCodes = extractCourseCodes(codeCell.html);
      const colId = getColId();

      // Continuation option row inside a pending choice group.
      // Catches: exact course codes, course ranges (e.g. MATH 407-499), and generic
      // placeholder options like "University Core Curriculum" that contain no course code.
      // Previously the guard required a course code or range, so plain-text options
      // (UCC, etc.) were dropped from the group — the fix widens the check to any
      // non-empty row with no credit hours while a pendingChoice is active.
      const cellHasRange = /\b[A-Z]{3,5}\s*\d{3}-\d{3,4}\b/i.test(codeCell.text);
      // Use code cell text first; fall back to title cell so we catch options where the
      // label sits in the description column rather than the code column.
      const optionLabel  = codeCell.text.trim() || titleCell?.text?.trim() || '';
      if (pendingChoice && hoursCell.text.trim() === '' && (codeCodes.length > 0 || cellHasRange || optionLabel.length > 0)) {
        if (codeCodes.length > 0 || cellHasRange) {
          // Exact course code(s) or range descriptor
          const { codes: optCodes, ranges: optRanges } = extractCourseCodesAndRanges(codeCell.html);
          for (const c of optCodes)  { if (!pendingChoice.allMatches.includes(c)) pendingChoice.allMatches.push(c); }
          for (const r of optRanges) { if (!pendingChoice.allMatches.includes(r)) pendingChoice.allMatches.push(r); }
          // Track per-row alternative structure for compound-choice detection.
          // A row whose code cell text starts with "&" or "and " is a bundle
          // continuation of the previous alternative (e.g. "& CHEM 238" continues
          // "CHEM 228" from the row above).  Otherwise it is a new alternative.
          if (optCodes.length > 0) {
            const cellText = codeCell.text.trim();
            const isContinuation = /^(&|and\s)/i.test(cellText);
            if (isContinuation && pendingChoice.rowAlternatives.length > 0) {
              // Append codes to the previous alternative to form a bundle
              const prev = pendingChoice.rowAlternatives[pendingChoice.rowAlternatives.length - 1];
              for (const c of optCodes) { if (!prev.courses.includes(c)) prev.courses.push(c); }
              prev.isBundle = prev.courses.length >= 2;
            } else {
              // New independent alternative.  Mark as bundle when a single row
              // contains multiple codes joined by "&" or "and" (not "or"/"/").
              const isBundle = optCodes.length >= 2 && /&|\band\b/i.test(cellText);
              pendingChoice.rowAlternatives.push({ courses: [...optCodes], isBundle });
            }
          }
        } else {
          // Generic/placeholder option (e.g. "University Core Curriculum", elective category)
          if (!pendingChoice.allMatches.includes(optionLabel)) pendingChoice.allMatches.push(optionLabel);
        }
        continue;
      }
      flushPendingChoice();
      nodeIdx++;

      // "Select N of/from …" header row — accumulate subsequent option rows. Handles
      // "Select one of the following", "Select 3 hours from the following", and the shorter
      // "Select 3 hours from:" variant (no "the following"), which several Math/Science
      // plans use for their elective pools (e.g. MATH 325 / MATH 407-499).
      // `selec?t` also matches the catalog's occasional "Selet" typo (e.g. Public Health BS).
      if (/^\s*selec?t\b.{0,45}?\b(from|of)\b/i.test(codeText)) {
        const isHoursBased = /\d+\s+hours?/i.test(codeText);
        const hoursVal     = parseInt((codeText.match(/(\d+)\s+hours?/i) ?? [])[1], 10) || null;
        const WORD_NUM     = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
        const countWord    = (codeText.match(/selec?t\s+(\w+)\s+of/i) ?? [])[1]?.toLowerCase();
        const pickCount    = isHoursBased ? null : (WORD_NUM[countWord] ?? 1);
        pendingChoice = {
          // Strip trailing footnote superscript numbers (e.g. "<sup>1</sup>" → " 1" after
          // stripTags) so titles like "Select one of the following: 1" become clean.
          title: codeText.trim().replace(/\s*:\s*\d+\s*$/, '').replace(/\s+\d+$/, '').trim(),
          hours, colId, allMatches: [],
          // rowAlternatives tracks each option row as a separate alternative so
          // compound "bundle OR single" groups (e.g. CHEM 228+238 vs CHEM 258) are
          // preserved rather than flattened into a single pool.
          rowAlternatives: [],
          isHoursBased, requiredHours: isHoursBased ? hoursVal : null, pickCount,
        };
        continue;
      }

      // Generic/comment row (colspan >= 2 or no course codes)
      if (codeCell.colspan >= 2 || codeCodes.length === 0) {
        if (hours > 0) {
          // Named requirement slot (elective, UCC, etc.) → placeholder node
          const label = codeText.replace(/\s+\d+(?:,\s*\d+)*\s*$/, '').trim() || codeText.trim() || 'Elective';
          // Distinguish UCC component-area slots and general/free electives from plain
          // major electives so the UI can render them differently.
          const electiveClass = classifyElectiveSlot(label);
          const displayTitle =
            electiveClass?.subtype === 'ucc'              ? electiveClass.category
            : electiveClass?.subtype === 'general_elective' ? 'General Elective'
            : label;
          // Every UCC component course is 3 SCH university-wide. Some plan grids show a UCC
          // slot as "3-4" (parsed as 4, e.g. a CHEM 120 / UCC cell), so force a single UCC
          // slot to 3. Multiples of 3 (3, 6, …) are preserved — a 6-hr UCC block is two
          // 3-hr courses and is split downstream.
          const slotHours = electiveClass?.subtype === 'ucc' && hours % 3 !== 0 ? 3 : hours;
          graphNodes.push({
            id: `placeholder-${nodeIdx}`,
            type: 'elective',
            column: colId,
            code: null,
            title: displayTitle.slice(0, 80),
            hours: slotHours,
            matches: [],
            prereqs: [],
            coreqs: [],
            required: false,
            requirementSubtype: electiveClass?.subtype ?? null,
          });
        } else {
          requirementGroups.push({ label: codeText.slice(0, 120), hours });
        }
        continue;
      }

      // Inline choice row: "STAT 211 or ECEN 303"
      if (/\bor\b/i.test(codeText) && codeCodes.length >= 2) {
        graphNodes.push({
          id: `choice-${nodeIdx}`,
          type: 'choice',
          column: colId,
          code: codeCodes.join(' / '),
          title: stripTags(titleCell.html),
          hours,
          matches: [...new Set(codeCodes)],
          options: [...new Set(codeCodes)],
          prereqs: [],
          coreqs: [],
          required: true,
        });
        continue;
      }

      // Cross-listed single row: "ENGR 216 / PHYS 216"
      if (codeCodes.length >= 2 && /\//.test(codeText)) {
        graphNodes.push({
          id: `node-${nodeIdx}`,
          type: 'choice',
          column: colId,
          code: codeCodes.join(' / '),
          title: stripTags(titleCell.html),
          hours,
          matches: [...new Set(codeCodes)],
          options: [...new Set(codeCodes)],
          prereqs: [],
          coreqs: [],
          required: true,
        });
        continue;
      }

      // Required co-enrollment bundle: "CHEM 107 & CHEM 117" / "PHYS 206 & PHYS 226"
      // These are lecture+lab or linked pairs that must be taken together.
      // Create two separate course nodes with mutual corequisite relationships so the
      // flowchart renders a bidirectional dashed coreq arrow between them.
      if (codeCodes.length >= 2 && /&/.test(codeText)) {
        const uniq = [...new Set(codeCodes)];
        uniq.forEach((courseCode, i) => {
          graphNodes.push({
            id: `node-${nodeIdx}-${i}`,
            type: 'course',
            column: colId,
            code: courseCode,
            title: courseCode,          // enrichNodes will fill in the real title
            hours: 0,                   // enrichNodes will fill in credit hours
            matches: [courseCode],
            prereqs: [],
            coreqs: uniq.filter((c) => c !== courseCode),
            required: true,
          });
        });
        continue;
      }

      // Normal single course
      graphNodes.push({
        id: `node-${nodeIdx}`,
        type: 'course',
        column: colId,
        code: codeCodes[0],
        title: stripTags(titleCell.html),
        hours,
        matches: [...new Set(codeCodes)],
        prereqs: [],
        coreqs: [],
        required: true,
      });
    }
    flushPendingChoice();
  }

  // Deduplicate exact required course nodes (guard against the same course code appearing
  // in multiple plan-grid rows, which would create duplicate standalone nodes)
  const seenRequiredCodes = new Set();
  const dedupedNodes = graphNodes.filter((n) => {
    if (n.type !== 'course' || !n.code) return true;
    if (seenRequiredCodes.has(n.code)) return false;
    seenRequiredCodes.add(n.code);
    return true;
  });

  // Subjects: only extract from nodes that have a real code (course/choice) so we fetch
  // the right catalog pages. Pool node matches may include range strings; their subject
  // prefix is still valid for catalog fetching (e.g. "MATH" from "MATH 407-499").
  const subjects = [...new Set(
    dedupedNodes
      .flatMap((n) => [n.code, ...(n.matches ?? [])].filter(Boolean))
      .map((c) => String(c).split(' ')[0])
      .filter((s) => /^[A-Z]{3,5}$/.test(s)),
  )];

  // The freshman year is omitted when the plan grid's first year row is "Second Year" (some
  // catalog years list only the track-specific Years 2-4 and rely on the common first-year
  // engineering program elsewhere).
  const firstYearOmitted = firstPlanYear != null
    && /\bsecond\s*year\b|\bsophomore\b/i.test(firstPlanYear)
    && !/\bfirst\s*year\b|\bfreshman\b/i.test(firstPlanYear);

  return { graphNodes: dedupedNodes, requirementGroups, subjects, summerColIds, firstYearOmitted };
}

/**
 * makeFirstYearEngineeringNodes – the shared TAMU first-year engineering program, injected
 * into Semesters 1-2 (col-0/col-1) for engineering plan grids that start at Second Year.
 * Hours are left 0 so enrichNodes fills the real catalog values; UCC slots are 3 hrs each.
 */
function makeFirstYearEngineeringNodes() {
  const courses = [
    [0, 'CHEM 107'], [0, 'CHEM 117'], [0, 'ENGR 102'], [0, 'MATH 151'], [0, 'ENGL 104'],
    [1, 'MATH 152'], [1, 'PHYS 206'], [1, 'ENGR 216'],
  ].map(([col, code], i) => ({
    id: `fy-eng-${i}`, type: 'course', column: `col-${col}`, code,
    title: code, hours: 0, matches: [], prereqs: [], coreqs: [],
  }));
  const ucc = [0, 1, 1].map((col, i) => ({
    id: `fy-ucc-${i}`, type: 'elective', column: `col-${col}`, code: null,
    title: 'University Core Curriculum', hours: 3, matches: [], prereqs: [], coreqs: [],
    requirementSubtype: 'ucc', required: false,
  }));
  return [...courses, ...ucc];
}

/**
 * parseCourseListAreas – parse the `sc_courselist` "Technical Coursework" tables that
 * appear below the plan grid on many engineering catalog pages.  These enumerate the
 * specific courses that satisfy named requirement areas (BREADTH / DESIGN / FOCUS) or,
 * for single-page multi-track majors (e.g. BMEN), each selectable track.
 *
 * Returns:
 *   {
 *     areas: [{
 *       areaName,            // header text, e.g. "BREADTH" or "Biomechanics"
 *       slug,                // kebab id derived from areaName
 *       isCatchAll,          // true for "...apply to any of the tracks above"
 *       selectLabels: [],    // raw "Select N hours from the following:" labels
 *       requiredHours,       // best-effort numeric requirement (max of parsed values)
 *       courses: [{ code, hours }],
 *     }],
 *     isTrackBased,          // page says "select one of the following tracks"
 *   }
 *
 * The course list is the source of truth for classification (each area becomes a
 * pick-N pool); perfect per-semester hour accounting is intentionally not attempted.
 */
function slugify(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'area';
}

// University Core Curriculum (UCC) foundational component areas. A plan-grid slot whose
// label names one of these is a CORE requirement — a specific category the student fills
// from a state-approved course list — NOT a free elective. Tagging it lets the UI show it
// as a UCC requirement (e.g. "American history", "Communication") distinct from a plain or
// general elective. Order matters only for label selection; the patterns are exclusive.
const UCC_CATEGORIES = [
  { re: /\bcommunication\b/i,                                          label: 'Communication' },
  { re: /life\s*(and|&)?\s*physical\s*science/i,                       label: 'Life and Physical Sciences' },
  { re: /language[,\s].*philosophy.*cultur/i,                          label: 'Language, Philosophy and Culture' },
  { re: /creative\s*arts/i,                                            label: 'Creative Arts' },
  { re: /american\s*history/i,                                         label: 'American History' },
  { re: /\b(government|political\s*science)\b/i,                       label: 'Government/Political Science' },
  { re: /social\s*(and|&)?\s*behavioral\s*science/i,                  label: 'Social and Behavioral Sciences' },
  { re: /^math(ematic)?s?\b/i,                                         label: 'Mathematics' },
  { re: /university\s*core\s*curriculum|core\s*curriculum|^ucc\b/i,    label: 'University Core Curriculum' },
];

// Free/unrestricted elective slots — distinct from major-restricted electives (e.g.
// "Technical elective", "Advanced chemistry", "Directed elective"), which stay plain.
const GENERAL_ELECTIVE_RE = /^(general|free|unrestricted)\s+electives?\b|^electives?$/i;

/**
 * classifyElectiveSlot – categorize a generic (codeless) elective placeholder label as a
 * UCC component area, a general/free elective, or neither (plain major elective).
 * @param {string} title  the slot label (footnotes already stripped)
 * @returns {{subtype:'ucc'|'general_elective', category:string|null}|null}
 */
function classifyElectiveSlot(title) {
  const t = String(title ?? '').trim();
  if (!t) return null;
  // A slot whose label explicitly says "… Elective(s)" is a subject-specific
  // elective, never a UCC/core-area requirement — even when the leading word
  // matches a UCC category (e.g. "MATH Elective", "Communication Elective").
  // Skip UCC classification so the label is preserved and it renders in the blue
  // elective box; general/free electives still fall through to their own bucket.
  const isNamedElective = /\belectives?\b/i.test(t);
  if (!isNamedElective) {
    for (const c of UCC_CATEGORIES) {
      if (c.re.test(t)) return { subtype: 'ucc', category: c.label };
    }
  }
  if (GENERAL_ELECTIVE_RE.test(t)) return { subtype: 'general_elective', category: null };
  return null;
}

/**
 * splitElectiveHours – break a multi-hour generic elective slot into course-sized
 * chunks so each shows as its own node (e.g. a 6-hr "Free Elective" → 3 + 3 rather
 * than one grouped box). Only splits slots of 6+ hours — smaller slots (4–5 hr) are
 * likely a single course.
 *
 * When the linked pool has a known uniform per-course size that divides evenly, use it.
 * Otherwise courses are 3–4 credit hours, so break the block into 3-hr chunks and absorb
 * any leftover hours by upsizing chunks to 4 (never leaving a 1-, 2-, or 5-hr fragment):
 *   9 → 3,3,3 · 10 → 3,3,4 · 11 → 3,4,4 · 8 → 4,4 · 7 → 3,4 · 12 → 3,3,3,3
 *
 * @param {number} totalHours
 * @param {number|null} unitHours  uniform per-course hours of the linked pool, if known
 * @returns {number[]} chunk hours (length 1 means "do not split")
 */
function splitElectiveHours(totalHours, unitHours = null) {
  const total = Number(totalHours) || 0;
  if (total < 6) return [total];
  // Pool with a known uniform per-course size that divides evenly → uniform chunks.
  if (unitHours && unitHours > 0 && total % unitHours === 0) {
    return Array.from({ length: total / unitHours }, () => unitHours);
  }
  // Generic 3-/4-hr course sizing: one 4-hr chunk per leftover hour (total % 3), rest 3-hr.
  const fours = total % 3;
  const threes = (total - 4 * fours) / 3;
  if (threes < 0) return [total]; // guard (only possible for total < 6, already handled)
  return [...Array(threes).fill(3), ...Array(fours).fill(4)];
}

function parseCourseListAreas(html) {
  const isTrackBased = /select\s+one\s+of\s+the\s+following\s+tracks/i.test(html);
  // When the plan grid uses "Directed elective" placeholder slots, the courselist's named
  // areas are the OPTION MENUS for those slots (pick some), NOT take-all required sets — so
  // their courses become a pool, not individually-required nodes. Scoped to this signal so
  // required areas in other majors (e.g. engineering Breadth/Focus) keep their behavior.
  const planGridHtml = (String(html ?? '').match(/<table[^>]*class="sc_plangrid"[\s\S]*?<\/table>/i) ?? [''])[0];
  const directedElectivePage = /directed\s+elective/i.test(stripTags(planGridHtml));
  const areas = [];
  const tables = [...String(html ?? '').matchAll(/<table[^>]*class="sc_courselist"[\s\S]*?<\/table>/gi)];

  for (const [tableHtml] of tables) {
    const rows = [...tableHtml.matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/gi)];
    let currentArea = null;
    // Which sub-section of the current area we are accumulating into:
    //   'pool'     — "Select from the following:" (the broad elective pool)
    //   'required' — "Required courses:" (must be taken when this track is chosen)
    //   'choice'   — "Select one of the following:" (pick one — a choice group)
    let currentSection = 'pool';

    const ensureArea = (name, hasHeader = false) => {
      const areaName = name || 'Technical Coursework';
      currentArea = {
        areaName,
        slug: slugify(areaName),
        hasHeader,
        isCatchAll: /apply\s+to\s+any\s+of\s+the\s+tracks/i.test(areaName),
        selectLabels: [],
        requiredHours: null,
        requiredHoursLabel: null, // raw hour range string for display, e.g. "6-9"
        courses: [],          // the broad elective pool ("Select from the following:")
        requiredCourses: [],  // courses listed directly / under "Required courses:" (mandatory)
        choiceGroups: [],     // [{ label, pickCount, requiredHours, courses:[{code,codes,hours}] }]
        _seen: new Set(),
        _seenReq: new Set(),
      };
      // Courses listed DIRECTLY under a NAMED area header (before any "Select…" comment) are
      // mandatory (e.g. Civil's Breadth: CVEN 301/307/339…). Headerless courselists (flat
      // footnote lists, e.g. Agribusiness) or "Select…" headers open a pool straight away —
      // we don't presume those courses are individually required.
      currentSection = (hasHeader && !directedElectivePage && !/select\s|apply\s+to\s+any/i.test(areaName)) ? 'required' : 'pool';
      areas.push(currentArea);
      return currentArea;
    };

    for (const [, attrs, rowHtml] of rows) {
      const cls = (attrs.match(/class="([^"]+)"/) ?? [])[1] ?? '';
      if (/hidden|noscript/.test(cls)) continue;

      // Area header row — starts a new requirement area / track
      const areaHdr = rowHtml.match(/<span[^>]*class="courselistcomment areaheader[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
      if (/areaheader/.test(cls) && areaHdr) {
        ensureArea(stripTags(areaHdr[1]), true);
        continue;
      }

      // Sub-requirement comment row ("Select from the following:", "Required courses:",
      // "Select one of the following:") — switches which section subsequent course rows
      // accumulate into.
      // Match "courselistcomment", "courselistcomment commentindent", etc. (but not the
      // areaheader variant, which is handled above and continues before reaching here).
      const comment = rowHtml.match(/<span[^>]*class="courselistcomment[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
      const hasCodecol = /class="[^"]*codecol/.test(rowHtml);
      if (comment && !hasCodecol) {
        if (!currentArea) ensureArea(null);
        const label = stripTags(comment[1]);
        currentArea.selectLabels.push(label);
        const hoursCell = rowHtml.match(/<td[^>]*class="hourscol"[^>]*>([\s\S]*?)<\/td>/i);
        const hoursRaw = hoursCell ? stripTags(hoursCell[1]).replace(/\s+/g, '').trim() : ''; // e.g. "6-9", "3"
        const parsed = parseCreditHours(hoursRaw);

        if (/required\s+cours/i.test(label)) {
          currentSection = 'required';
        } else if (/select\s+\w+\s+of\s+the\s+following/i.test(label)) {
          // "Select one/two of the following:" — a discrete choice group within the track
          currentSection = 'choice';
          const WORD_NUM = { one: 1, two: 2, three: 3, four: 4 };
          const word = (label.match(/select\s+(\w+)\s+of/i) ?? [])[1]?.toLowerCase();
          currentArea.choiceGroups.push({
            label,
            pickCount: WORD_NUM[word] ?? 1,
            requiredHours: parsed > 0 ? parsed : null,
            courses: [],
            _seen: new Set(),
          });
        } else {
          // "Select from the following:" (or anything else) → the broad pool
          currentSection = 'pool';
          if (parsed > 0) currentArea.requiredHours = Math.max(currentArea.requiredHours ?? 0, parsed);
          // Preserve the raw hour range ("6-9") for display — the primary pool select wins.
          if (/\d/.test(hoursRaw) && !currentArea.requiredHoursLabel) currentArea.requiredHoursLabel = hoursRaw;
        }
        continue;
      }

      // Course row. Each row is ONE course (its anchors may carry cross-listed "/" codes,
      // e.g. "CVEN 301/EVEN 301"). A row whose code cell starts with "or" is an alternative
      // to the preceding course — those collapse into a choice group.
      if (hasCodecol) {
        if (!currentArea) ensureArea(null);
        const hoursCell = rowHtml.match(/<td[^>]*class="hourscol"[^>]*>([\s\S]*?)<\/td>/i);
        const rowHours  = hoursCell ? parseCreditHours(stripTags(hoursCell[1])) : 0;
        const codecol   = rowHtml.match(/<td[^>]*class="[^"]*codecol[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
        const codecolText = stripTags(codecol ? codecol[1] : '');
        const isOrRow   = /^or\b/i.test(codecolText);
        // All distinct course codes in this row (cross-listed variants of one course).
        const rowCodes = [];
        for (const [, inner] of [...rowHtml.matchAll(/<a[^>]*class="bubblelink code"[^>]*>([\s\S]*?)<\/a>/gi)]) {
          for (const c of extractCourseCodes(stripTags(inner))) if (!rowCodes.includes(c)) rowCodes.push(c);
        }
        if (rowCodes.length === 0) continue;
        const primary = rowCodes[0];
        const entry = { code: primary, codes: rowCodes, hours: rowHours };
        const lastChoice = currentArea.choiceGroups[currentArea.choiceGroups.length - 1];

        if (currentSection === 'choice') {
          if (lastChoice && !lastChoice._seen.has(primary)) { lastChoice._seen.add(primary); lastChoice.courses.push(entry); }
        } else if (currentSection === 'pool') {
          if (!currentArea._seen.has(primary)) { currentArea._seen.add(primary); currentArea.courses.push(entry); }
        } else {
          // 'required' section
          if (isOrRow && lastChoice && lastChoice._fromRequired) {
            // Another "or" alternative — extend the just-formed choice group.
            if (!lastChoice._seen.has(primary)) { lastChoice._seen.add(primary); lastChoice.courses.push(entry); }
          } else if (isOrRow && currentArea.requiredCourses.length > 0) {
            // "CVEN 342" (required) followed by "or CVEN 343" → a choose-one group.
            const prev = currentArea.requiredCourses.pop();
            currentArea._seenReq.delete(prev.code);
            currentArea.choiceGroups.push({
              label: 'Select one', pickCount: 1, requiredHours: null,
              courses: [prev, entry], _seen: new Set([prev.code, primary]), _fromRequired: true,
            });
          } else if (!currentArea._seenReq.has(primary)) {
            currentArea._seenReq.add(primary);
            currentArea.requiredCourses.push(entry);
          }
        }
      }
    }
  }

  // Drop the internal dedupe/marker fields before returning
  for (const a of areas) {
    delete a._seen;
    delete a._seenReq;
    for (const g of a.choiceGroups) { delete g._seen; delete g._fromRequired; }
  }
  // Keep areas that have at least one course in any sub-section
  return {
    areas: areas.filter(
      (a) => a.courses.length > 0 || a.requiredCourses.length > 0 || a.choiceGroups.length > 0,
    ),
    isTrackBased,
  };
}

/**
 * clauseToPrereqGroups – split one prereq clause's codes into OR-alternative groups.
 * A clause that joins its courses with "or" (and no "and") is a single "satisfy one of
 * these" group — e.g. "AGEC 105, ECON 203, or grade of C in ECON 202" → one group of 3.
 * Anything else (an "and" list, a bare comma list, or a single code) is treated as all
 * required → one singleton group per code. The grade-qualifier "or" ("C or better",
 * "or higher") is stripped first so it isn't mistaken for a logical OR.
 * @param {string} clauseText  the raw clause text (for connector detection)
 * @param {string[]} codes     course codes already extracted from the clause
 * @returns {string[][]}
 */
function clauseToPrereqGroups(clauseText, codes) {
  if (codes.length === 0) return [];
  if (codes.length === 1) return [[codes[0]]];
  // Drop grade noise ("or better/higher/above") so it isn't read as an OR between courses.
  const logical = String(clauseText).replace(/\bor\s+(better|higher|above)\b/ig, ' ');

  // Proper AND-of-OR parse: split the clause into AND-segments, then within each segment
  // treat "or"-joined codes (incl. a comma list ending in "or") as interchangeable
  // alternatives → one group. A comma list with no "or" (part of an "A, B, and C" all-
  // required list) stays as separate groups. Handles mixed clauses like STAT 421's
  //   "STAT 211, and STAT 404 or CSCE 221, or ECEN 303, and CSCE 121 or CSCE 120"
  //   → [STAT 211], [STAT 404, CSCE 221, ECEN 303], [CSCE 121, CSCE 120]
  const groups = [];
  const placed = new Set();
  for (const segment of logical.split(/\band\b/i)) {
    const segCodes = extractCourseCodes(segment).filter((c) => codes.includes(c) && !placed.has(c));
    if (segCodes.length === 0) continue;
    if (segCodes.length >= 2 && /\bor\b/i.test(segment)) groups.push(segCodes.slice());
    else for (const c of segCodes) groups.push([c]);
    for (const c of segCodes) placed.add(c);
  }
  // Any code not captured by segmentation → its own required group (safety net).
  for (const c of codes) if (!placed.has(c)) groups.push([c]);
  return groups.length ? groups : codes.map((c) => [c]);
}

/**
 * parseCourseCatalogPage – parse TAMU /undergraduate/course-descriptions/{subject}/ HTML.
 * Returns { [code]: { code, title, hours, prereqs, coreqs, prereqGroups } }.
 */
function parseCourseCatalogPage(html) {
  const courses = {};
  const blocks = [...html.matchAll(/<div class="courseblock">/gi)];

  blocks.forEach((match, i) => {
    const start = match.index;
    const end = i + 1 < blocks.length ? blocks[i + 1].index : html.length;
    const block = html.slice(start, end);

    // Code + title from <h2 class="courseblocktitle">
    const titleHtml = (block.match(/<h2[^>]*class="courseblocktitle"[^>]*>([\s\S]*?)<\/h2>/i) ?? [])[1] ?? '';
    const titleText = stripTags(titleHtml);
    const codeMatch = titleText.match(/\b([A-Z]{3,5})\s+(\d{3}[A-Z]?)\b/);
    if (!codeMatch) return;

    const code = `${codeMatch[1]} ${codeMatch[2]}`;
    // Title is everything after "CODE NNN. " (with optional credit suffix).
    // Cross-listed entries look like "EVEN 304/CVEN 304 Environmental Engineering Lab" —
    // slicing after "EVEN 304" leaves "/CVEN 304 Environmental Engineering Lab".
    // Strip the leading "/CODE NNN " cross-listing prefix before using the title.
    const title = titleText
      .slice(titleText.indexOf(codeMatch[0]) + codeMatch[0].length)
      .replace(/^\/[A-Z]{3,5}\s+\d{3}[A-Z]?\s*/i, '')
      .replace(/^[\s.]+/, '')
      .replace(/\s*\d+\s*Credits?\s*$/i, '')
      .trim();

    // Credit hours – look for "Credits N" anywhere in the block text
    const creditsMatch = stripTags(block).match(/\bCredits?\s+(\d+(?:\.\d+)?)\b/i);
    const hours = creditsMatch ? parseFloat(creditsMatch[1]) : 0;

    // Strip the h2 from block for prereq search
    const descHtml = block.replace(/<h2[^>]*>[\s\S]*?<\/h2>/i, '');

    const prereqHtml = (descHtml.match(/<strong>Prerequisites?[^<]*<\/strong>([\s\S]*?)(?=<strong>|<\/p>|<p\s|$)/i) ?? [])[1] ?? '';
    const coreqHtml  = (descHtml.match(/<strong>Corequisites?[^<]*<\/strong>([\s\S]*?)(?=<strong>|<\/p>|<p\s|$)/i) ?? [])[1] ?? '';

    // Start with any explicitly-labelled corequisites (their own <strong>Corequisites</strong> section)
    const coreqs = extractCourseCodes(coreqHtml).filter((c) => c !== code);

    // Parse the prerequisite text clause-by-clause to correctly handle three patterns:
    //
    //   Pattern A: "X or concurrent enrollment in Y"
    //              X = prerequisite,  Y = corequisite
    //   Pattern B: "concurrent enrollment in X [or Y]"
    //              X, Y = corequisite
    //   Pattern C: "X and Y, or concurrent enrollment"  (no "in" — backward reference)
    //              X, Y = corequisite
    //
    // CRITICAL — strip HTML before splitting: dots inside href URLs (e.g. "catalog.tamu.edu")
    // would otherwise fragment a clause like "MEEN 357 and MEEN 305, or concurrent enrollment"
    // into separate segments, losing MEEN 357.
    const prereqText = stripTags(prereqHtml);
    const prereqs = [];
    const concurrentOnlyCodes = new Set(); // codes that are concurrent-only (go to coreqs, not prereqs)
    const firmPrereqCodes = new Set();     // codes named in a firm (non-concurrent) branch — these win over a coreq
    const prereqGroups = [];               // AND-of-OR structure: each entry is a set of interchangeable alternatives

    const clauses = prereqText.split(/[.;]/);
    for (const rawClause of clauses) {
      const clause = rawClause.trim();
      if (!clause) continue;

      // "registration therein" / "concurrent registration" are TAMU idioms for "may be taken
      // concurrently" — e.g. "NUEN 410 or registration therein" makes NUEN 410 a COREQ, not a
      // strict prereq. "registration therein" refers backward (Pattern C → coreqs).
      const hasConcurrent = /concurrent enrollment|concurrent registration|registration therein/i.test(clause);

      if (!hasConcurrent) {
        // Scheduling/sequencing tails ("…must be taken … prior to ESET 420", "before X",
        // "followed by X") reference a SUCCESSOR course (taken later), not a prerequisite —
        // truncate the clause there so that successor isn't picked up as a prereq.
        const seqIdx = clause.search(/\b(prior to|before|preceding|followed by|subsequent to|in preparation for)\b/i);
        const clauseForPrereqs = seqIdx !== -1 ? clause.slice(0, seqIdx) : clause;
        // No concurrent pattern — every code in this clause is a plain prerequisite
        const clauseCodes = [];
        for (const c of extractCourseCodes(clauseForPrereqs)) {
          if (c === code) continue;
          if (!prereqs.includes(c)) prereqs.push(c);
          firmPrereqCodes.add(c);
          clauseCodes.push(c);
        }
        // Preserve the clause's OR-vs-AND structure ("A, B, or C" = one group; "A and B" =
        // two groups) so the UI can show interchangeable alternatives.
        for (const g of clauseToPrereqGroups(clauseForPrereqs, clauseCodes)) prereqGroups.push(g);
        continue;
      }

      // Does "concurrent enrollment" come with "in [courses]"?
      const inIdx = clause.search(/concurrent enrollment in/i);
      if (inIdx !== -1) {
        // Pattern A / B — split on "concurrent enrollment in"
        const before = clause.slice(0, inIdx);
        const after  = clause.slice(inIdx + 'concurrent enrollment in'.length);

        // Codes BEFORE "concurrent enrollment in" → prerequisites (each independently required)
        for (const c of extractCourseCodes(before)) {
          if (c !== code && !prereqs.includes(c)) { prereqs.push(c); prereqGroups.push([c]); }
        }
        // Codes AFTER "concurrent enrollment in" → corequisites
        for (const c of extractCourseCodes(after)) {
          if (c !== code) {
            if (!coreqs.includes(c)) coreqs.push(c);
            concurrentOnlyCodes.add(c);
          }
        }
      } else {
        // Pattern C — "X and Y, or concurrent enrollment" (backward reference, no "in").
        //
        // A clause may join several ALTERNATIVE prereq branches with "or grade [of C or
        // better] in …", where the trailing "concurrent enrollment" allowance applies only
        // to the branch it sits in. e.g. ECEN 403:
        //   "…grade of C or better in ECEN 303, ECEN 322, and ECEN 370,   ← firm branch
        //    or grade C or better in CSCE 331 …, or concurrent enrollment" ← concurrent branch
        // Treating the whole clause as concurrent (the old behavior) wrongly demoted the
        // firm branch's courses (ECEN 303/322/370) to corequisites. Sub-split on "or grade"
        // branch boundaries so only the branch that actually contains the concurrent phrase
        // becomes coreqs; firm branches stay prerequisites. A single-branch clause (no
        // "or grade") keeps the original behavior — every code → corequisite.
        for (const branch of clause.split(/\bor\s+grade\b/i)) {
          const branchConcurrent =
            /concurrent enrollment|concurrent registration|registration therein/i.test(branch);
          for (const c of extractCourseCodes(branch)) {
            if (c === code) continue;
            if (branchConcurrent) {
              if (!coreqs.includes(c)) coreqs.push(c);
              concurrentOnlyCodes.add(c);
            } else {
              if (!prereqs.includes(c)) { prereqs.push(c); prereqGroups.push([c]); }
              firmPrereqCodes.add(c);
            }
          }
        }
      }
    }

    // A concurrent-only code is removed from prereqs (it could have been added by an earlier
    // clause before "concurrent enrollment in" appeared) — UNLESS it also appears in a firm
    // branch, in which case the firm prerequisite wins (e.g. ECEN 403 lists ECEN 303 in both
    // its firm branch and its concurrent branch → it is a prerequisite, not a coreq).
    const finalPrereqs = prereqs.filter((c) => firmPrereqCodes.has(c) || !concurrentOnlyCodes.has(c));
    const finalCoreqs = [...new Set(coreqs)].filter((c) => !firmPrereqCodes.has(c));

    // Finalize the OR-groups to mirror finalPrereqs: drop concurrent-only codes, de-dup a
    // code to its first group, and drop now-empty groups.
    const groupSeen = new Set();
    const finalPrereqGroups = prereqGroups
      .map((g) => g.filter((c) => finalPrereqs.includes(c) && !groupSeen.has(c) && groupSeen.add(c)))
      .filter((g) => g.length > 0);

    courses[code] = { code, title, hours, prereqs: finalPrereqs, coreqs: finalCoreqs, prereqGroups: finalPrereqGroups };
  });

  return courses;
}

/**
 * enrichNodes – fetch course description pages for subjects, add title/hours/prereqs/coreqs to nodes.
 * Returns { enrichedNodes, courseCatalog }.
 */
async function enrichNodes(graphNodes, subjects) {
  const courseCatalog = {};

  await Promise.allSettled(
    subjects.map(async (subject) => {
      const url = `${CATALOG_BASE}/undergraduate/course-descriptions/${subject.toLowerCase()}/`;
      try {
        const html = await fetchHtml(url);
        Object.assign(courseCatalog, parseCourseCatalogPage(html));
      } catch {
        // Subject page may not exist – silently skip
      }
    }),
  );

  const enrichedNodes = graphNodes.map((n) => {
    // Don't enrich placeholder, pool, or path-option nodes — they have no single canonical
    // course record. Inheriting prereqs from the first matched option would incorrectly
    // draw edges out of a flexible requirement slot to its own listed options.
    if (!n.code || n.type === 'elective' || n.type === 'path_option') return n;
    const info = courseCatalog[n.code] ?? n.matches?.map((m) => courseCatalog[m]).find(Boolean);
    return {
      ...n,
      title:   info?.title ?? n.title,
      hours:   (n.hours > 0 ? n.hours : null) ?? (info?.hours > 0 ? info.hours : null) ?? 0,
      prereqs: info?.prereqs ?? n.prereqs ?? [],
      coreqs:  info?.coreqs  ?? n.coreqs  ?? [],
      prereqGroups: info?.prereqGroups ?? n.prereqGroups ?? null,
    };
  });

  return { enrichedNodes, courseCatalog };
}

/**
 * buildEdgesFromNodes – generate prerequisite/corequisite edges from node prereqs/coreqs.
 */
function buildEdgesFromNodes(nodes) {
  // For pool/flexible nodes (code=null), their matches[] list option courses that are NOT
  // standalone graph nodes. Exclude them from knownCodes to prevent dangling edge references
  // where some other node lists an option course as its prerequisite.
  const knownCodes = new Set(
    nodes.flatMap((n) => (n.code ? [n.code, ...(n.matches ?? [])] : [])).filter(Boolean),
  );
  const edges = [];
  const seen = new Set();
  const warnings = [];

  // Collect all coreq pairs first so prereq edges can defer to them
  const coreqPairs = new Set();
  for (const n of nodes) {
    for (const coreq of n.coreqs ?? []) {
      if (knownCodes.has(coreq)) coreqPairs.add(`${coreq}->${n.code}`);
    }
  }

  for (const n of nodes) {
    for (const prereq of n.prereqs ?? []) {
      if (!knownCodes.has(prereq)) {
        // External prereq (not in degree plan) — skip to keep edges in-plan only
        warnings.push(`Prereq ${prereq} of ${n.code} is outside the degree plan.`);
        continue;
      }
      // If a coreq edge already covers this pair ("prereq or concurrent enrollment"),
      // skip the redundant solid prereq edge so only the dashed coreq is shown.
      if (coreqPairs.has(`${prereq}->${n.code}`)) continue;
      const key = `${prereq}->pre->${n.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: prereq, to: n.code, type: 'prerequisite', rawText: '' });
    }
    for (const coreq of n.coreqs ?? []) {
      if (!knownCodes.has(coreq)) continue; // skip external coreqs too
      const key = `${coreq}->co->${n.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: coreq, to: n.code, type: 'corequisite', rawText: '' });
    }
  }

  return { edges, warnings };
}

/**
 * patchKnownCoreqEdges – hardcoded edge overrides for specific lecture+lab pairs.
 * Strips all parser-generated edges between these courses, then injects the exact
 * directed edges we want.
 */
function patchKnownCoreqEdges(edges, knownCodes) {
  // Courses whose edges we fully control — strip everything the parser produced.
  const CONTROLLED = new Set(['CHEM 107', 'CHEM 117', 'CHEM 227', 'CHEM 237', 'CHEM 228', 'CHEM 238']);

  // Exact edges to inject (if both endpoints exist in this plan's graph)
  const FORCED = [
    { from: 'CHEM 117', to: 'CHEM 107', type: 'corequisite' },
    { from: 'CHEM 107', to: 'CHEM 117', type: 'corequisite' },
    { from: 'CHEM 237', to: 'CHEM 227', type: 'corequisite' },
    { from: 'CHEM 227', to: 'CHEM 237', type: 'corequisite' },
    { from: 'CHEM 238', to: 'CHEM 228', type: 'corequisite' },
    { from: 'CHEM 228', to: 'CHEM 238', type: 'corequisite' },
    { from: 'CHEM 227', to: 'CHEM 228', type: 'prerequisite' },
  ];

  // Keep all edges that don't involve any two controlled codes
  const filtered = edges.filter(
    (e) => !(CONTROLLED.has(e.from) && CONTROLLED.has(e.to)),
  );

  // Inject forced edges where both nodes are present in this plan
  for (const e of FORCED) {
    if (knownCodes.has(e.from) && knownCodes.has(e.to)) {
      filtered.push({ ...e, rawText: '' });
    }
  }

  return filtered;
}

// ---------------------------------------------------------------------------
// Load static degree-plans.json
// ---------------------------------------------------------------------------
let staticPlansCache = null;
function loadStaticPlans() {
  if (staticPlansCache) return staticPlansCache;
  try {
    const raw = fs.readFileSync(DEGREE_PLANS_PATH, 'utf8');
    staticPlansCache = JSON.parse(raw)?.plans ?? [];
  } catch {
    staticPlansCache = [];
  }
  return staticPlansCache;
}

/** Load pre-built graph data from build-degree-graphs.mjs offline output. */
let generatedGraphsCache = null;
function loadGeneratedGraphs() {
  if (generatedGraphsCache) return generatedGraphsCache;
  try {
    const raw = fs.readFileSync(GENERATED_GRAPHS_PATH, 'utf8');
    generatedGraphsCache = JSON.parse(raw) ?? {};
  } catch {
    generatedGraphsCache = {};
  }
  return generatedGraphsCache;
}

function invalidateGeneratedGraphsCache() {
  generatedGraphsCache = null;
}

/**
 * Convert a static plan from degree-plans.json into the canonical graph shape.
 */
function buildGraphFromStaticPlan(plan) {
  const nodes = [];
  const edges = [];

  for (const node of plan.graphNodes ?? []) {
    const subj = node.code?.split(' ')[0] ?? null;
    const num  = node.code?.split(' ')[1] ?? null;
    nodes.push({
      id:               node.id,
      code:             node.code,
      subject:          subj,
      number:           num,
      title:            node.title ?? '',
      creditHours:      node.hours ?? null,
      requirementType:  node.type === 'choice' ? 'choice' : (node.required ? 'required' : 'elective'),
      semesterColumn:   node.column ?? null,
      rawRequirementText: '',
      matches:          node.matches ?? [],
      requirementSubtype: node.requirementSubtype ?? null,
      alternatives:     node.alternatives ?? null,
      pickCount:        node.pickCount ?? null,
      requiredHours:    node.requiredHours ?? null,
      prereqs:          node.prereqs ?? [],
      coreqs:           node.coreqs ?? [],
    });
    // Build edges from prereqs
    for (const prereq of node.prereqs ?? []) {
      edges.push({ from: prereq, to: node.code, type: 'prerequisite', rawText: '' });
    }
    for (const coreq of node.coreqs ?? []) {
      edges.push({ from: coreq, to: node.code, type: 'corequisite', rawText: '' });
    }
  }

  return {
    programId:  plan.id,
    catalog:    plan.catalog ?? null,
    title:      plan.title ?? '',
    sourceUrl:  null,
    nodes,
    edges,
    flexibleRequirements: plan.flexibleRequirements ?? [],
    warnings:   [],
    source:     'static',
  };
}

// ---------------------------------------------------------------------------
// Catalog scraper – full implementation ported from reference catalog-degree-plans.mjs
// ---------------------------------------------------------------------------
async function fetchHtml(url) {
  let lastErr;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(String(url), {
        headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'zlp-scheduler/1.0' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return await res.text();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Resolve the catalog URL for a programId using the catalogUrl field from
 * academic-programs.json, falling back to a constructed path.
 */
function resolveCatalogUrl(programId) {
  if (!programId.startsWith('catalog-major:')) return null;
  try {
    const { getAcademicProgram } = require('./academicPrograms');
    const prog = getAcademicProgram(programId);
    if (prog.catalogUrl) return prog.catalogUrl;
  } catch { /* fall through */ }
  // Constructed fallback: strip catalog-year suffix (:2025-2026) from path
  const rel = programId.slice('catalog-major:'.length).replace(/^\/+/, '').replace(/:[^/]+$/, '');
  return `${CATALOG_BASE}/undergraduate/${rel}/`;
}

/**
 * Scrape the TAMU catalog page for a degree program, extract course nodes
 * with semester columns from the plan grid, enrich with course descriptions,
 * and build prerequisite/corequisite edges.
 */
async function scrapeGraphFromCatalog(programId) {
  const url = resolveCatalogUrl(programId);
  const warnings = [];

  if (!url) {
    return {
      programId, catalog: null, title: programId, sourceUrl: null,
      nodes: [], edges: [], flexibleRequirements: [],
      warnings: ['Not a catalog-major program ID.'],
      source: 'scraped',
    };
  }

  let html;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    return {
      programId, catalog: null, title: programId, sourceUrl: url,
      nodes: [], edges: [], flexibleRequirements: [],
      warnings: [`Could not fetch catalog page: ${err.message}`],
      source: 'scraped',
    };
  }

  // Extract page title — try program-specific selectors; fall back to academic-programs.json title
  let title = programId;
  const h1Match = html.match(/<h1[^>]*class="[^"]*page-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)
    ?? html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h1Text = h1Match ? stripTags(h1Match[1]) : '';
  if (h1Text && !/texas a&m university catalogs?/i.test(h1Text) && h1Text.length < 120) {
    title = h1Text;
  } else {
    // Use the title from academic-programs.json
    try {
      const { getAcademicProgram } = require('./academicPrograms');
      title = getAcademicProgram(programId).title ?? programId;
    } catch { title = programId; }
  }

  // Parse plan grid into nodes (with year/term column IDs)
  const { graphNodes, requirementGroups, subjects, summerColIds, firstYearOmitted } = parsePlanTableFromHtml(html);

  if (graphNodes.length === 0) {
    warnings.push('No course nodes found in catalog plan grid.');
  }

  // Engineering track pages that start at "Second Year" (common in archived catalog years
  // for sub-tracks like Coastal) omit the shared freshman year. Prepend the standard
  // first-year engineering program and shift the existing Years 2-4 right by two columns.
  if (firstYearOmitted && /\bengineering\b/i.test(programId)) {
    for (const n of graphNodes) {
      const m = /^col-(\d+)$/.exec(n.column ?? '');
      if (m) n.column = `col-${Number(m[1]) + 2}`;
    }
    graphNodes.unshift(...makeFirstYearEngineeringNodes());
    for (const s of ['CHEM', 'ENGR', 'MATH', 'PHYS', 'ENGL']) {
      if (!subjects.includes(s)) subjects.push(s);
    }
    warnings.push('Injected shared first-year engineering program (plan grid started at Second Year).');
  }

  // Parse the `sc_courselist` "Technical Coursework" tables — the named requirement
  // areas (BREADTH / DESIGN / FOCUS …) or selectable tracks (BMEN) that enumerate the
  // courses satisfying the plan grid's generic "Technical coursework" / elective slots.
  const { areas: courseListAreas, isTrackBased } = parseCourseListAreas(html);

  // Program-specific post-processing: catalog pages that use generic placeholders
  // for courses that are known/enumerable.
  if (/computer-engineering/i.test(programId)) {
    // CPEN Senior Design: 6 credit hours chosen from one of two paths
    // per the public TAMU Undergraduate Catalog:
    //   Path 1 — ECEN 403 + ECEN 404 (two 3-hr courses)
    //   Path 2 — CSCE 483 + 3 hrs Area Elective
    // The plan grid shows the 6-hr block as TWO 3-hr "Senior design" placeholder cells.
    // Collapse BOTH cells into a single 6-hr path_option node: the first cell becomes the
    // node and the second is dropped (it's subsumed — each path already enumerates its full
    // course set, so an always-present standalone "Area Elective" node would be wrong for
    // Path 1, whose second slot is ECEN 404, not an elective).
    let seniorDesignConverted = false;
    const seniorDesignDropIdx = [];
    for (let i = 0; i < graphNodes.length; i++) {
      const n = graphNodes[i];
      if (n.type === 'elective' && /senior\s*design/i.test(n.title ?? '')) {
        if (!subjects.includes('ECEN')) subjects.push('ECEN');
        if (!subjects.includes('CSCE')) subjects.push('CSCE');
        if (!seniorDesignConverted) {
          graphNodes[i] = {
            ...n,
            type: 'path_option',
            code: null,
            title: 'Senior Design',
            // The single node represents the WHOLE 6-hr block (both plan-grid cells).
            hours: 6,
            // Synthetic alias so buildReactFlowGraph can resolve edges targeting this node
            matches: ['CPEN-SENIOR-DESIGN'],
            paths: [
              {
                id: 'ecen-design-path',
                label: 'ECEN Senior Design (ECEN 403 + ECEN 404)',
                courses: ['ECEN 403', 'ECEN 404'],
                additionalRequirements: [],
                // Path 1 entrance — ECEN 403's prerequisites (TAMU catalog). Always required:
                // ECEN 314/325/350 and ECEN 303 (it appears in both prereq branches). CSCE 331
                // (software) and ECEN 449 (microprocessors) are the in-CPEN-plan courses from
                // ECEN 403's CSCE-alternative branch — "CSCE 315 or CSCE 331, … and ECEN 449
                // or CSCE 462" — which CPEN students satisfy via CSCE 331 + ECEN 449.
                prereqs: ['ECEN 314', 'ECEN 325', 'ECEN 350', 'ECEN 303', 'CSCE 331', 'ECEN 449'],
              },
              {
                id: 'csce-design-path',
                label: 'CSCE Senior Design (CSCE 483 + Area Elective)',
                courses: ['CSCE 483'],
                additionalRequirements: ['3 hours Area Elective'],
                // Path 2 entrance — CSCE 483's catalog prereqs (CSCE 462/ECEN 449 are cross-listed).
                prereqs: ['CSCE 331', 'CSCE 462', 'ECEN 449', 'ECEN 325'],
              },
            ],
            prereqs: [],
            coreqs: [],
          };
          seniorDesignConverted = true;
        } else {
          // Second 3-hr "Senior design" cell — folded into the 6-hr path_option node above.
          seniorDesignDropIdx.push(i);
        }
      }
    }
    // Remove the now-subsumed second senior-design cell(s) (descending so indices hold).
    for (let k = seniorDesignDropIdx.length - 1; k >= 0; k--) {
      graphNodes.splice(seniorDesignDropIdx[k], 1);
    }
  }

  // Fetch course description pages and enrich nodes with title/hours/prereqs/coreqs
  let enrichedNodes = graphNodes;
  let courseCatalog = {};
  if (subjects.length > 0) {
    try {
      const result = await enrichNodes(graphNodes, subjects);
      enrichedNodes = result.enrichedNodes;
      courseCatalog = result.courseCatalog;
    } catch (err) {
      warnings.push(`Partial course enrichment: ${err.message}`);
    }
  }

  // ── Per-option prereq/coreq data for choice nodes ─────────────────────────
  // A choice node ("AERO 430 / MATH 401 / MATH 412") currently inherits the FIRST
  // option's prereqs via enrichNodes, so its edges always point at option #1. To let
  // the UI cycle through options and show each one's prereq/coreq chain, compute a
  // per-option map and clear the node's inherited prereqs so no static first-option
  // edge is generated. Per-option edges are added after the main edge pass below.
  //
  // First, fetch any catalog subjects referenced only by choice options / track pools
  // that weren't already fetched for the plan grid.
  const extraSubjects = new Set();
  const addSubj = (code) => {
    const s = String(code ?? '').split(' ')[0];
    if (s && !courseCatalog[code] && !subjects.includes(s)) extraSubjects.add(s);
  };
  for (const n of enrichedNodes) {
    if (n.type === 'choice') for (const m of n.matches ?? []) addSubj(m);
  }
  for (const a of courseListAreas) {
    for (const c of a.requiredCourses ?? []) addSubj(c.code);
    for (const g of a.choiceGroups ?? []) for (const c of g.courses) addSubj(c.code);
  }
  if (extraSubjects.size > 0) {
    await Promise.allSettled(
      [...extraSubjects].map(async (subject) => {
        try {
          const html2 = await fetchHtml(`${CATALOG_BASE}/undergraduate/course-descriptions/${subject.toLowerCase()}/`);
          Object.assign(courseCatalog, parseCourseCatalogPage(html2));
        } catch { /* subject page may not exist */ }
      }),
    );
  }

  // Set of all course codes that exist as real nodes in this plan (for in-plan filtering)
  const inPlanCodes = new Set(
    enrichedNodes.flatMap((n) => (n.code ? [n.code, ...(n.matches ?? [])] : [])).filter(Boolean),
  );
  // Codes that ARE or WILL BECOME resolvable nodes — includes options inside pool/choice
  // nodes (code=null). A course like CHEM 120 lives inside the "CHEM 120 / UCC" pool now
  // but is collapsed to a real required node later; without this, its prereq edge into the
  // organic-chem choice (CHEM 257 needs CHEM 120) would be wrongly filtered out. Edges to
  // codes that never become real nodes are simply dropped client-side.
  const resolvableCodes = new Set(
    enrichedNodes.flatMap((n) => [n.code, ...(n.matches ?? [])]).filter(Boolean),
  );
  // Distinguish CROSS-LISTED courses (same course, two department codes — e.g.
  // CSCE 222/ECEN 222, ENGR 216/PHYS 216, BMEN 428/CSCE 461) from GENUINE choices
  // (two different courses that satisfy the same slot but have different prereqs —
  // e.g. ECEN 449 vs CSCE 462). The reliable signal is the prerequisite set: cross-
  // listed variants share identical prereqs/coreqs, genuine alternatives don't.
  //   • Cross-listed  → collapse to one required course node labelled "A / B".
  //   • Genuine choice → keep as a choice node with per-option prereq cycling.
  const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  for (const n of enrichedNodes) {
    if (n.type !== 'choice') continue;
    if (n.requirementSubtype === 'exact_compound_choice') continue; // bundle choices stay
    const opts = (n.matches ?? []).filter((m) => /^[A-Z]{3,5}\s\d{3}[A-Z]?$/.test(String(m)));
    if (opts.length < 2) continue;

    // Full prereq/coreq sets + normalized title per option (for cross-listed test).
    const fullPre = {}, fullCo = {}, titleOf = {};
    for (const code of opts) {
      const info = courseCatalog[code];
      fullPre[code] = new Set((info?.prereqs ?? []).map((p) => normalizeCourseCode(p)).filter(Boolean));
      fullCo[code]  = new Set((info?.coreqs  ?? []).map((p) => normalizeCourseCode(p)).filter(Boolean));
      titleOf[code] = String(info?.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    }
    const first = opts[0];
    // Cross-listed = the SAME course under two department codes: identical title AND
    // identical prereqs/coreqs. Genuine alternatives (different courses, e.g. ENGL 103 vs
    // ENGL 104, ECEN 449 vs CSCE 462) differ in title and/or prereqs → stay a choice.
    const allTitlesKnown = opts.every((c) => titleOf[c].length > 0);
    const isCrossListed = allTitlesKnown
      && opts.every((c) => titleOf[c] === titleOf[first] && setEq(fullPre[c], fullPre[first]) && setEq(fullCo[c], fullCo[first]));

    if (isCrossListed) {
      // Same course under two codes — render as a single required course node using the
      // FIRST code as its primary identity (just like any normal course node). Both codes
      // stay in matches so either satisfies the requirement; the alternate is shown as a
      // small subtitle on the node.
      const info = courseCatalog[first];
      n.type = 'course';
      n.requirementSubtype = 'cross_listed';
      n.code = first;
      n.matches = opts;
      n.title = info?.title ?? n.title ?? first;
      n.hours = (n.hours > 0 ? n.hours : null) ?? (info?.hours > 0 ? info.hours : null) ?? 0;
      n.prereqs = info?.prereqs ?? [];
      n.coreqs  = info?.coreqs ?? [];
      n.optionPrereqs = null;
      n.optionCoreqs  = null;
      continue;
    }

    // Genuine choice — record each option's in-plan prereqs/coreqs for live cycling.
    // Exclude prereqs that are themselves OTHER options of this same choice node (e.g.
    // ECON 203 is a prereq of ECON 202 but both satisfy the same slot) — that prereq has no
    // separate node to draw an arrow from, so it would just self-loop on the choice node.
    const optsSet = new Set(opts);
    const optionPrereqs = {};
    const optionCoreqs  = {};
    for (const code of opts) {
      optionPrereqs[code] = [...fullPre[code]].filter((p) => resolvableCodes.has(p) && !optsSet.has(p));
      optionCoreqs[code]  = [...fullCo[code]].filter((p) => resolvableCodes.has(p) && !optsSet.has(p));
    }
    n.optionPrereqs = optionPrereqs;
    n.optionCoreqs  = optionCoreqs;
    // Clear inherited prereqs/coreqs so buildEdgesFromNodes doesn't draw first-option edges.
    n.prereqs = [];
    n.coreqs  = [];
  }

  // Compound choice nodes (e.g. "OCNG 451 OR PHYS 207 + PHYS 227"): treat each ALTERNATIVE
  // as a cyclable option keyed by its joined courses ("PHYS 207+PHYS 227"). For a bundle,
  // a single option's prereqs are the UNION of its courses' in-plan prereqs, so cycling to
  // that alternative lights up the whole bundle's chain at once.
  for (const n of enrichedNodes) {
    if (n.type !== 'choice' || n.requirementSubtype !== 'exact_compound_choice') continue;
    if (!Array.isArray(n.alternatives)) continue;
    // Courses that belong to this same node (across all alternatives) have no separate
    // node — skip them as prereq sources so we don't draw a self-loop arrow.
    const ownCourses = new Set(n.alternatives.flatMap((alt) => alt.courses ?? []));
    const optionPrereqs = {}, optionCoreqs = {};
    const optionEdges = [];
    for (const alt of n.alternatives) {
      const key = (alt.courses ?? []).join('+');
      const pre = new Set(), co = new Set();
      for (const code of alt.courses ?? []) {
        const info = courseCatalog[code];
        for (const p of (info?.prereqs ?? [])) {
          const pc = normalizeCourseCode(p);
          if (pc && resolvableCodes.has(pc) && !ownCourses.has(pc)) { pre.add(pc); optionEdges.push({ from: pc, to: code, type: 'prerequisite', optionCode: key }); }
        }
        for (const p of (info?.coreqs ?? [])) {
          const pc = normalizeCourseCode(p);
          if (pc && resolvableCodes.has(pc) && !ownCourses.has(pc)) { co.add(pc); optionEdges.push({ from: pc, to: code, type: 'corequisite', optionCode: key }); }
        }
      }
      optionPrereqs[key] = [...pre];
      optionCoreqs[key]  = [...co];
    }
    n.optionPrereqs = optionPrereqs;
    n.optionCoreqs  = optionCoreqs;
    n.optionEdges   = optionEdges; // emitted into the edge set after edges are built
    n.prereqs = [];
    n.coreqs  = [];
  }

  // ── Summer column shift ───────────────────────────────────────────────────
  // Standalone Summer columns (e.g. a High Impact Experience, or a summer course like
  // BUSN 484) break the standard 8-semester (4-year) Fall/Spring flowchart layout. Move
  // EVERY summer course — regardless of credit hours — to the subsequent term so it sits in
  // the next Fall/Spring (e.g. a summer-before-senior-year course lands in senior Fall) and
  // the Summer column is eliminated from the grid.
  if (summerColIds.size > 0) {
    const allColNums = enrichedNodes
      .map((n) => parseInt((n.column ?? '').replace('col-', ''), 10))
      .filter((n) => !isNaN(n));
    const maxColNum = allColNums.length > 0 ? Math.max(...allColNums) : -1;
    for (const n of enrichedNodes) {
      if (!summerColIds.has(n.column)) continue;
      const colNum = parseInt(n.column.replace('col-', ''), 10);
      const nextCol = `col-${colNum + 1}`;
      if (colNum + 1 <= maxColNum) n.column = nextCol;
    }
  }

  // Collapse empty column gaps so the grid is contiguous. Eliminating the Summer column
  // above (or any other empty slot) otherwise leaves a hole that makes labels read e.g.
  // "Semester 6…9" with a missing 5 — looking like 9 semesters instead of 8.
  {
    const usedNums = [...new Set(
      enrichedNodes.map((n) => parseInt((n.column ?? '').replace('col-', ''), 10)).filter((x) => !isNaN(x)),
    )].sort((a, b) => a - b);
    const remap = new Map();
    usedNums.forEach((old, i) => remap.set(old, i));
    for (const n of enrichedNodes) {
      const m = /^col-(\d+)$/.exec(n.column ?? '');
      if (m && remap.has(Number(m[1]))) n.column = `col-${remap.get(Number(m[1]))}`;
    }
  }

  // Build edges from prereqs/coreqs arrays now on each node
  let { edges, warnings: edgeWarnings } = buildEdgesFromNodes(enrichedNodes);
  warnings.push(...edgeWarnings.slice(0, 10)); // cap edge warnings to avoid noise

  // Apply hardcoded corrections for known lecture+lab coreq pairs whose catalog
  // wording produces incorrect cross-course arrows.
  const knownCodes = new Set(
    enrichedNodes.flatMap((n) => (n.code ? [n.code, ...(n.matches ?? [])] : [])).filter(Boolean),
  );
  edges = patchKnownCoreqEdges(edges, knownCodes);

  // ── Per-option choice edges ───────────────────────────────────────────────
  // Emit one edge per (option → its in-plan prereq/coreq), tagged with optionCode so
  // the UI can show only the currently-selected option's chain. Target is the option
  // code itself (resolves to the choice node via its matches alias on the frontend).
  for (const n of enrichedNodes) {
    if (n.type !== 'choice') continue;
    // Compound (bundle) choices carry explicit per-alternative edges (target = the real
    // course in the bundle, tagged with the alternative key).
    if (Array.isArray(n.optionEdges)) {
      for (const e of n.optionEdges) edges.push({ ...e, rawText: '' });
      continue;
    }
    if (!n.optionPrereqs) continue;
    for (const [optCode, preList] of Object.entries(n.optionPrereqs)) {
      for (const pre of preList) {
        edges.push({ from: pre, to: optCode, type: 'prerequisite', rawText: '', optionCode: optCode });
      }
    }
    for (const [optCode, coList] of Object.entries(n.optionCoreqs ?? {})) {
      for (const co of coList) {
        edges.push({ from: co, to: optCode, type: 'corequisite', rawText: '', optionCode: optCode });
      }
    }
  }

  // CPEN: inject the Senior Design prerequisite lines, tagged per PATH so the UI shows
  // only the selected path's entrance chain. The path_option node uses the synthetic alias
  // 'CPEN-SENIOR-DESIGN' (in its matches[]) so edges targeting it resolve by code lookup;
  // optionCode = the path id (matches the path selector on the node).
  if (/computer-engineering/i.test(programId)) {
    const sdNode = enrichedNodes.find((n) => n.type === 'path_option');
    for (const path of sdNode?.paths ?? []) {
      for (const fromCode of path.prereqs ?? []) {
        edges.push({ from: fromCode, to: 'CPEN-SENIOR-DESIGN', type: 'prerequisite', rawText: '', optionCode: path.id });
      }
    }
  }

  // ── CHEM 120 / UCC collapse ───────────────────────────────────────────────
  // A "Select one of the following: CHEM 120 / University Core Curriculum" slot is
  // parsed as an elective pool whose options are one real course plus placeholder
  // label(s). When that course is a hard prerequisite of a required course in the
  // plan, the UCC alternative isn't truly optional — collapse the pool to a plain
  // required course node so it renders as a normal clickable node and classifies as
  // exact_required.
  const REAL_CODE_RE = /^[A-Z]{3,5}\s\d{3}[A-Z]?$/;
  // CHEM 107 + CHEM 117 are the OR-alternative to CHEM 120 in some degree prereqs
  // (e.g. MEEN 223 accepts EITHER CHEM 120 OR CHEM 107 & CHEM 117). When both
  // alternatives appear together in one node's prereq list, CHEM 120 is not a hard
  // requirement — don't mark it as critical in those cases.
  const CHEM120_ALTS = new Set(['CHEM 107', 'CHEM 117']);
  // COE degrees that follow the CHEM 119 → CHEM 120 chemistry track rather than the
  // general CHEM 107/117 path. Their catalog plan grids still list CHEM 107/117 + an
  // optional "CHEM 120 / UCC" slot, but the only CHEM-120 consumer (organic chem) sits
  // in a choice node behind an OR, so prereq-chain detection alone can't distinguish
  // them from CHEM 107/117 degrees like Mechanical. This curated list (per program
  // partition) forces the 119/120 track for those majors.
  const CHEM119_TRACK_RE = /chemical|biomedical|materials-science|msen|materials-engineering/i;
  const usesChem119Track = CHEM119_TRACK_RE.test(programId);

  const prereqCriticalCodes = new Set();
  if (usesChem119Track) prereqCriticalCodes.add('CHEM 120');
  for (const n of enrichedNodes) {
    if (n.type !== 'course') continue;
    const nodePrereqs = [...(n.prereqs ?? []), ...(n.coreqs ?? [])]
      .map((p) => normalizeCourseCode(p)).filter(Boolean);
    for (const pc of nodePrereqs) {
      if (pc === 'CHEM 120') {
        // Only critical when no CHEM 107/117 alternative is listed alongside it
        if (usesChem119Track || !nodePrereqs.some((p) => CHEM120_ALTS.has(p))) {
          prereqCriticalCodes.add('CHEM 120');
        }
      } else {
        prereqCriticalCodes.add(pc);
      }
    }
  }
  for (let i = 0; i < enrichedNodes.length; i++) {
    const n = enrichedNodes[i];
    if (n.code || !['elective', 'choice'].includes(n.type)) continue;
    const matches = n.matches ?? [];
    const realCodes   = matches.filter((m) => REAL_CODE_RE.test(String(m).toUpperCase().trim()));
    const placeholders = matches.filter((m) => !REAL_CODE_RE.test(String(m).toUpperCase().trim()));
    if (realCodes.length !== 1 || placeholders.length === 0) continue;
    const code = String(realCodes[0]).toUpperCase().trim();

    if (!prereqCriticalCodes.has(code)) {
      // The real course isn't required by any later course. For a "CHEM 120 / UCC" slot
      // this means the student takes the UCC option — drop the course and render a plain
      // University Core Curriculum placeholder instead of the choice.
      if (code === 'CHEM 120') {
        const rawUcc = placeholders.find((p) => /core|ucc|university/i.test(p)) ?? 'University Core Curriculum';
        const uccLabel = rawUcc.replace(/\s+[\d,]+\s*$/, '').trim(); // strip trailing footnote "3,5"
        enrichedNodes[i] = {
          ...n,
          type:    'elective',
          code:    null,
          title:   uccLabel,
          // The UCC alternative is 3 SCH — not CHEM 120's 4 — so the slot is 3 hrs here.
          hours:   3,
          matches: [],
          prereqs: [],
          coreqs:  [],
          requirementSubtype: 'ucc',
        };
        warnings.push(`CHEM 120 not required by any later course — rendered "${uccLabel}" only.`);
      }
      continue;
    }

    const info = courseCatalog[code];
    enrichedNodes[i] = {
      ...n,
      type:    'course',
      code,
      title:   info?.title ?? n.title ?? code,
      hours:   (n.hours > 0 ? n.hours : null) ?? (info?.hours > 0 ? info.hours : null) ?? 0,
      matches: [code],
      prereqs: info?.prereqs ?? [],
      coreqs:  info?.coreqs ?? [],
    };
    // Draw the prereq edge(s) into the required course(s) that depend on it.
    for (const m of enrichedNodes) {
      if (m.type !== 'course' || !m.code) continue;
      const needs = [...(m.prereqs ?? []), ...(m.coreqs ?? [])]
        .map((p) => normalizeCourseCode(p)).includes(code);
      if (needs) edges.push({ from: code, to: m.code, type: 'prerequisite', rawText: '' });
    }
    warnings.push(`Collapsed "${n.title ?? 'choice'}" to required ${code} (prerequisite of a required course).`);
  }

  // ── CHEM 119 substitution ─────────────────────────────────────────────────
  // Degrees that require CHEM 120 use the CHEM 119 → CHEM 120 chemistry track.
  // Their plan grids still show CHEM 107 & CHEM 117 in semester 1 (the general
  // engineering chemistry path), but those are wrong for students following the
  // 119/120 path. When CHEM 120 was just collapsed to a required node, swap out
  // CHEM 107 and CHEM 117 for CHEM 119 in the same semester column.
  const chem120IsRequired = enrichedNodes.some((n) => n.code === 'CHEM 120' && n.type === 'course');
  if (chem120IsRequired) {
    const chem107Node = enrichedNodes.find((n) => n.code === 'CHEM 107' && n.type === 'course');
    if (chem107Node) {
      const chemColumn = chem107Node.column;
      // Remove CHEM 107 + CHEM 117 from the node list and from the edge set
      for (let i = enrichedNodes.length - 1; i >= 0; i--) {
        const n = enrichedNodes[i];
        if ((n.code === 'CHEM 107' || n.code === 'CHEM 117') && n.type === 'course') {
          enrichedNodes.splice(i, 1);
        }
      }
      edges = edges.filter(
        (e) => e.from !== 'CHEM 107' && e.to !== 'CHEM 107' && e.from !== 'CHEM 117' && e.to !== 'CHEM 117',
      );
      // Insert CHEM 119 (Fundamentals of Chemistry I) in that column
      const chem119Info = courseCatalog['CHEM 119'];
      enrichedNodes.unshift({
        id:       'node-chem-119',
        type:     'course',
        column:   chemColumn,
        code:     'CHEM 119',
        title:    chem119Info?.title ?? 'Fundamentals of Chemistry I',
        hours:    chem119Info?.hours > 0 ? chem119Info.hours : 4,
        matches:  ['CHEM 119'],
        prereqs:  chem119Info?.prereqs ?? [],
        coreqs:   chem119Info?.coreqs ?? [],
        required: true,
      });
      // CHEM 119 → CHEM 120 prerequisite edge
      edges.push({ from: 'CHEM 119', to: 'CHEM 120', type: 'prerequisite', rawText: '' });
      warnings.push('Substituted CHEM 119 for CHEM 107/117 (CHEM 119 → CHEM 120 track).');
    }
  }

  // ── Area / track requirement pools (from the sc_courselist table) ──────────
  // Generic plan-grid placeholders like "Technical coursework" only state an hour
  // count; the real course options live in the courselist areas. Replace those
  // placeholders with explicit, named pool nodes so the options are visible and the
  // classifier recognises them (each pool → pick-N → preferred, locked to its list).
  // Capstone is skipped here — the plan grid already encodes it as a choice row.
  const SKIP_AREA_RE        = /capstone/i;
  const GENERIC_SLOT_RE     = /technical\s*(coursework|elective)|breadth|design|focus|area\s*elective|track\s*elective|theme\s*elective|emphasis/i;
  // Drop courses that are already explicit nodes in the plan grid. Many catalogs repeat
  // the plan-grid courses inside footnote courselists (e.g. Agribusiness) — re-adding them
  // as area nodes just stacks duplicates. The plan grid is the source of truth for those;
  // courselists only contribute the track/area courses the grid shows as placeholders.
  const prunedAreas = courseListAreas
    .filter((a) => !SKIP_AREA_RE.test(a.areaName))
    .map((a) => ({
      ...a,
      requiredCourses: (a.requiredCourses ?? []).filter((c) => !inPlanCodes.has(c.code)),
      choiceGroups:    (a.choiceGroups ?? [])
        .map((g) => ({ ...g, courses: g.courses.filter((c) => !inPlanCodes.has(c.code)) }))
        .filter((g) => g.courses.length >= 2),   // a 1-option "choice" isn't a choice
      courses:         (a.courses ?? []).filter((c) => !inPlanCodes.has(c.code)),
    }))
    // Keep only areas that still have content after pruning plan-grid duplicates.
    .filter((a) => a.requiredCourses.length > 0 || a.choiceGroups.length > 0 || a.courses.length > 0);
  const poolAreas           = prunedAreas;
  const haveAreas           = poolAreas.length > 0;

  // Concentration/theme degrees (e.g. Environmental Studies): a NON-track plan whose
  // requirement areas are mutually-exclusive themes the student picks ONE of. The reliable
  // signal is the "Select the REMAINING courses from the following" phrasing (take a few
  // anchor courses, then fill the rest from that theme's list) — distinct from Civil-style
  // "Select N hours from the following" areas, which are all completed and whose courses we
  // place individually. In concentration mode each theme renders as ONE pool box instead of
  // exploding every theme's anchor + pool courses into nodes that pile up at the grid's end.
  const isConcentrationBased = !isTrackBased
    && poolAreas.some((a) => (a.selectLabels ?? []).some((l) => /\bremaining\b/i.test(l)));

  // Area required/choice courses become real individual nodes (or resolvable choice options),
  // so register their codes as in-plan BEFORE edges are built. Otherwise a prereq edge BETWEEN
  // two area courses (e.g. CVEN 365 → CVEN 435, both DESIGN/BREADTH area courses) is filtered
  // out by the in-plan check and never drawn. (Concentration themes collapse to one pool box,
  // so their courses don't become individual nodes — skip them.)
  if (!isConcentrationBased) {
    for (const a of poolAreas) {
      for (const c of a.requiredCourses ?? []) {
        for (const code of (c.codes?.length ? c.codes : [c.code])) if (code) inPlanCodes.add(code);
      }
      for (const g of a.choiceGroups ?? []) {
        for (const c of g.courses ?? []) if (c.code) inPlanCodes.add(c.code);
      }
    }
  }

  // Last plan-grid column — park the pool nodes at the end of the grid.
  const lastColumn = enrichedNodes.reduce((best, n) => {
    const m = /^col-(\d+)$/.exec(n.column ?? '');
    return m && Number(m[1]) > best.idx ? { idx: Number(m[1]), col: n.column } : best;
  }, { idx: -1, col: null }).col;

  // ── Semester placement for area required/choice courses (Civil-style) ──────
  // Rather than dumping every Breadth/Design required course at the end, place each in
  // the EARLIEST semester whose prereqs are already satisfied, capping each column at
  // ~17 hrs (placeholder budget). Pools/track electives stay at the end.
  const PLACEMENT_CAP = 17;
  const colHours = {};                 // col index → summed credit hours
  const courseCol = new Map();         // course code → col index (where it's placed)
  let maxColIdx = 0;
  for (const n of enrichedNodes) {
    const m = /^col-(\d+)$/.exec(n.column ?? '');
    if (!m) continue;
    const idx = Number(m[1]);
    maxColIdx = Math.max(maxColIdx, idx);
    // Skip generic placeholder slots (Breadth/Design/etc.) that will be dropped — their
    // hour budget is reallocated to the real area courses we're about to place.
    const isGenericSlot = n.type === 'elective' && !n.code
      && (n.matches?.length ?? 0) === 0 && GENERIC_SLOT_RE.test(n.title ?? '');
    if (!isGenericSlot) colHours[idx] = (colHours[idx] ?? 0) + (n.hours ?? 0);
    for (const c of (n.code ? [n.code, ...(n.matches ?? [])] : [])) courseCol.set(c, idx);
  }
  // Find the earliest column at/after all prereqs that still has hour budget, place there.
  // `budget` is the per-context column-hours map being filled (shared for Civil's single
  // track; a fresh copy per BMEN track so tracks don't crowd each other out of columns).
  function placeByPrereqs(prereqCodes, hours, ownCodes, budget) {
    let minCol = 0;
    for (const p of prereqCodes ?? []) {
      const pc = normalizeCourseCode(p);
      if (pc && courseCol.has(pc)) minCol = Math.max(minCol, courseCol.get(pc) + 1);
    }
    if (minCol > maxColIdx) minCol = maxColIdx;
    let placed = maxColIdx;
    for (let c = minCol; c <= maxColIdx; c++) {
      if ((budget[c] ?? 0) + hours <= PLACEMENT_CAP) { placed = c; break; }
    }
    budget[placed] = (budget[placed] ?? 0) + hours;
    for (const c of (ownCodes ?? [])) courseCol.set(c, placed); // later courses may depend on this
    return `col-${placed}`;
  }
  const baseColHours = { ...colHours };   // immutable snapshot of plan-grid load per column
  const sharedBudget = { ...colHours };   // running budget for non-track (Civil) placement

  // Drop generic placeholders now represented by named pools.
  const keptNodes = !haveAreas ? enrichedNodes : enrichedNodes.filter((n) => {
    const isGenericSlot = n.type === 'elective' && !n.code
      && (n.matches?.length ?? 0) === 0
      && GENERIC_SLOT_RE.test(n.title ?? '');
    return !isGenericSlot;
  });

  // Build one pool node per area that actually has a pick-N pool. Areas whose content is
  // entirely required courses / choice groups (e.g. Civil's Breadth) have no pool node —
  // their courses are emitted as individual required/choice nodes below instead. The
  // optional "…apply to any of the tracks" catch-all is dropped (it's a 0-3 hr extra, not a
  // real per-track requirement, and only added noise to the flowchart).
  const poolNodes = poolAreas
    .filter((a) => !a.isCatchAll && (isConcentrationBased
      ? (a.courses.length + (a.requiredCourses?.length ?? 0) + (a.choiceGroups?.length ?? 0)) > 0
      : a.courses.length > 0))
    .map((a, i, arr) => {
    // Spread pool boxes across the last TWO semesters — first half in the 2nd-to-last column,
    // the rest in the last — so several of them (concentration themes, or Civil-style
    // BREADTH/DESIGN/FOCUS/SCIENCE area requirements) don't stack up in one column while the
    // prior semester sits nearly empty. Only for non-track plans (track pools are filtered to
    // the chosen track client-side, so a server-side index split would be inconsistent); a
    // lone pool box stays in the last column.
    const lastIdx = Number((lastColumn ?? 'col-0').replace('col-', '')) || 0;
    const secondToLastCol = lastIdx >= 1 ? `col-${lastIdx - 1}` : lastColumn;
    const poolCol = (!isTrackBased && arr.length >= 2)
      ? (i < Math.ceil(arr.length / 2) ? secondToLastCol : lastColumn)
      : lastColumn;
    // In concentration mode every theme is one pool box listing ALL its courses (anchor
    // "required" courses + choice options + select-from pool); otherwise just the pool courses.
    const codes = isConcentrationBased
      ? [...new Set([
          ...a.courses.map((c) => c.code),
          ...(a.requiredCourses ?? []).map((c) => c.code),
          ...(a.choiceGroups ?? []).flatMap((g) => (g.courses ?? []).map((c) => c.code)),
        ])]
      : a.courses.map((c) => c.code);
    const trackId = (isTrackBased && !a.isCatchAll) ? a.slug : null;
    const poolTitle = a.areaName;
    return {
      id:               `area-${a.slug}`,
      code:             null,
      subject:          null,
      number:           null,
      title:            poolTitle,
      creditHours:      a.requiredHours ?? null,
      requirementType:  'elective',
      semesterColumn:   poolCol,
      rawRequirementText: a.selectLabels.join(' '),
      matches:          codes,
      paths:            [],
      requirementSubtype: isTrackBased ? 'track_pool' : 'area_pool',
      alternatives:     null,
      pickCount:        null,
      requiredHours:    a.requiredHours ?? null,
      requiredHoursLabel: a.requiredHoursLabel ?? null, // raw range string, e.g. "6-9"
      trackId,
      // Catch-all pools ("…apply to any of the tracks") count regardless of track.
      isCatchAllPool:   isTrackBased && a.isCatchAll,
      prereqs:          [],
      coreqs:           [],
      // per-course hours (used by Phase 2 splitting for generic slots elsewhere)
      poolCourses:      a.courses,
    };
  });

  // Track-required courses + within-track choice groups. Within a track (e.g. BMEN's
  // "Imaging" track) some courses are REQUIRED (not just pick-N), and there may be a
  // "Select one of the following" choice. Emit these as track-gated nodes so they
  // classify as required/choice — but only when the student has chosen that track.
  // In concentration mode each theme is already one pool box, so skip emitting its courses
  // as individual nodes.
  const trackSubNodes = [];
  for (const a of (isConcentrationBased ? [] : poolAreas)) {
    const trackId = (isTrackBased && !a.isCatchAll) ? a.slug : null;
    const gateSubtype = (kind) => isTrackBased ? `track_${kind}` : `area_${kind}`;
    // Placement budget: each BMEN track gets its own fresh copy of the plan-grid load
    // (only one track is ever shown, so tracks shouldn't crowd each other out of columns).
    // Civil's areas share one running budget.
    const budget = isTrackBased ? { ...baseColHours } : sharedBudget;

    for (const c of a.requiredCourses ?? []) {
      const info = courseCatalog[c.code];
      const inPlanPre = (info?.prereqs ?? []).map((p) => normalizeCourseCode(p)).filter((p) => p && inPlanCodes.has(p));
      const inPlanCo  = (info?.coreqs  ?? []).map((p) => normalizeCourseCode(p)).filter((p) => p && inPlanCodes.has(p));
      const altCodes = (c.codes && c.codes.length > 1) ? c.codes : [c.code];
      const reqHours = c.hours || (info?.hours > 0 ? info.hours : 3);
      // Place each required course into the earliest semester whose prereqs are satisfied.
      const reqCol = placeByPrereqs(info?.prereqs, reqHours, altCodes, budget);
      trackSubNodes.push({
        id:               `track-req-${a.slug}-${slugify(c.code)}`,
        code:             c.code,
        subject:          c.code.split(' ')[0],
        number:           c.code.split(' ')[1],
        title:            info?.title ?? c.code,
        creditHours:      c.hours || (info?.hours > 0 ? info.hours : null),
        requirementType:  'required',
        requirementSubtype: gateSubtype('required'),
        semesterColumn:   reqCol,
        rawRequirementText: `${a.areaName} — Required`,
        matches:          altCodes, // cross-listed variants (e.g. CVEN 301 / EVEN 301)
        paths:            [],
        alternatives:     null,
        pickCount:        null,
        requiredHours:    null,
        trackId,
        isCatchAllPool:   false,
        prereqs:          info?.prereqs ?? [],
        coreqs:           info?.coreqs ?? [],
      });
      // Prereq/coreq edges into this track-required node (resolve only when track shown).
      for (const p of inPlanPre) edges.push({ from: p, to: c.code, type: 'prerequisite', rawText: '' });
      for (const p of inPlanCo)  edges.push({ from: p, to: c.code, type: 'corequisite',  rawText: '' });
    }

    (a.choiceGroups ?? []).forEach((g, gi) => {
      const codes = g.courses.map((c) => c.code);
      if (codes.length === 0) return;
      const codesSet = new Set(codes); // exclude same-node options as prereq sources (no self-loop)
      const optionPrereqs = {};
      const optionCoreqs  = {};
      for (const code of codes) {
        const info = courseCatalog[code];
        optionPrereqs[code] = (info?.prereqs ?? []).map((p) => normalizeCourseCode(p)).filter((p) => p && inPlanCodes.has(p) && !codesSet.has(p));
        optionCoreqs[code]  = (info?.coreqs  ?? []).map((p) => normalizeCourseCode(p)).filter((p) => p && inPlanCodes.has(p) && !codesSet.has(p));
        for (const p of optionPrereqs[code]) edges.push({ from: p, to: code, type: 'prerequisite', rawText: '', optionCode: code });
        for (const p of optionCoreqs[code])  edges.push({ from: p, to: code, type: 'corequisite',  rawText: '', optionCode: code });
      }
      const chHours = g.requiredHours || 3;
      const chCol = placeByPrereqs(optionPrereqs[codes[0]], chHours, [], budget);
      trackSubNodes.push({
        id:               `track-choice-${a.slug}-${gi}`,
        code:             codes.join(' / '),
        subject:          null,
        number:           null,
        title:            g.label?.replace(/:\s*\d.*$/, '').trim() || 'Select one',
        creditHours:      g.requiredHours ?? null,
        requirementType:  'choice',
        requirementSubtype: gateSubtype('choice'),
        semesterColumn:   chCol,
        rawRequirementText: g.label ?? '',
        matches:          codes,
        paths:            [],
        alternatives:     null,
        pickCount:        g.pickCount ?? 1,
        requiredHours:    null,
        trackId,
        isCatchAllPool:   false,
        optionPrereqs,
        optionCoreqs,
        prereqs:          [],
        coreqs:           [],
      });
    });
  }

  if (haveAreas) {
    warnings.push(`Parsed ${poolAreas.length} requirement area pool(s) from courselist${isTrackBased ? ' (track-based)' : ''}.`);
  }

  // Convert to canonical node schema shape. Generic multi-hour elective placeholders
  // (no specific course, no option list) are split into course-sized nodes so each
  // shows distinctly instead of one grouped "Elective 6 hrs" box.
  const planNodes = keptNodes.flatMap((n) => {
    const subj = n.code ? n.code.split(' ')[0] : null;
    const num  = n.code ? n.code.split(' ')[1] : null;
    const base = {
      id:               n.id,
      code:             n.code ?? null,
      subject:          subj,
      number:           num,
      title:            n.title ?? '',
      creditHours:      n.hours ?? null,
      requirementType:  n.type === 'choice'      ? 'choice'
                      : n.type === 'elective'    ? 'elective'
                      : n.type === 'path_option' ? 'path_option'
                      : 'required',
      semesterColumn:   n.column ?? null,
      rawRequirementText: '',
      matches:          n.matches ?? [],
      paths:            n.paths  ?? [],
      requirementSubtype: n.requirementSubtype ?? null,
      alternatives:     n.alternatives ?? null,
      pickCount:        n.pickCount ?? null,
      requiredHours:    n.requiredHours ?? null,
      trackId:          n.trackId ?? null,
      optionPrereqs:    n.optionPrereqs ?? null,
      optionCoreqs:     n.optionCoreqs ?? null,
      prereqs:          n.prereqs ?? [],
      coreqs:           n.coreqs ?? [],
      prereqGroups:     n.prereqGroups ?? null,
    };

    const isGenericElective = base.requirementType === 'elective' && !base.code
      && (base.matches?.length ?? 0) === 0;
    const chunks = isGenericElective ? splitElectiveHours(base.creditHours) : [base.creditHours];
    if (chunks.length <= 1) return [base];

    return chunks.map((h, i) => ({
      ...base,
      id:          `${base.id}-${i + 1}`,
      creditHours: h,
    }));
  });

  const nodes = [...planNodes, ...poolNodes, ...trackSubNodes];

  // Selectable tracks for single-page multi-track majors (BMEN-style).
  const availableTracks = isTrackBased
    ? poolAreas
        .filter((a) => !a.isCatchAll)
        .map((a) => ({
          id:            a.slug,
          name:          a.areaName,
          requiredHours: a.requiredHours ?? null,
          courses:       a.courses.map((c) => c.code),
        }))
    : null;

  const catYearMatch = programId.match(/:(\d{4}-\d{4})$/);
  const catalog = catYearMatch ? catYearMatch[1] : '2025-2026';

  return {
    programId,
    catalog,
    title,
    sourceUrl: url,
    nodes,
    edges,
    flexibleRequirements: requirementGroups,
    availableTracks,
    warnings,
    source: 'scraped',
  };
}

// ---------------------------------------------------------------------------
// Main public API
// ---------------------------------------------------------------------------

// Bump this when parsePlanTableFromHtml logic changes to invalidate stale cached graphs.
// v7: fix concurrent-enrollment clause detection (strip HTML before split to avoid
//     dots inside href URLs fragmenting clauses, e.g. MEEN 357 was missed for MEEN 363).
// v13: compound-choice bundle detection (e.g. CHEM 228 & CHEM 238 vs CHEM 258) added to
//      parsePlanTableFromHtml — invalidate all cached graphs so they re-scrape with the
//      new alternatives[] data required by courseClassifier's compound-bundle path.
// v31: (a) prereq parser now sub-splits "or grade…" branches so a firm branch's courses
//      (e.g. ECEN 403's ECEN 303/322/370) stay prerequisites instead of being demoted to
//      corequisites by a trailing "or concurrent enrollment"; (b) CPEN Senior Design
//      collapses both plan-grid cells into one 6-hr path_option node (Path 1 = ECEN 403 +
//      ECEN 404) and drops the stray Area Elective node. Re-scrape to pick both up.
// v32: add CSCE 331 to CPEN Senior Design Path 1 prereqs — it's the in-plan course from
//      ECEN 403's "CSCE 315 or CSCE 331" branch and was missing an edge into the node.
// v33: tag generic elective placeholders with requirementSubtype 'ucc' (University Core
//      Curriculum component areas — Communication, American History, Creative Arts, etc.)
//      or 'general_elective' so the UI renders them distinctly from major electives.
// v34: force UCC slots to 3 SCH (all UCC courses are 3 university-wide) — fixes the
//      CHEM 120 / UCC cell that inherited CHEM 120's 4 hrs on non-CHEM-120 engineering plans.
// v35: emit prereqGroups (AND-of-OR structure) per course so the UI can show interchangeable
//      "satisfy one of these" prerequisite alternatives as a color-coded group.
// v36: move ALL summer-term courses (not just 0/1-credit ones) to the subsequent Fall/Spring
//      term so e.g. BUSN 484 lands in senior Fall (semester 7) and the Summer column is gone.
// v37: split non-3-divisible generic electives into 3-/4-hr chunks (e.g. a 10-hr ECEN
//      elective → 3,3,4) instead of leaving one oversized box.
// v38: concentration/theme degrees (e.g. Environmental Studies) render each theme as ONE
//      pool box instead of exploding every theme's courses into individual nodes that piled
//      up at the end of the grid.
// v39: spread concentration theme pool boxes across the last two semesters (half in each)
//      so they're not all compacted in the final column.
// v40: register area required/choice course codes as in-plan so prereq/coreq edges BETWEEN
//      area courses (e.g. CVEN 365 → CVEN 435) are drawn instead of filtered out.
// v41: spread ALL non-track area pool boxes (Civil BREADTH/DESIGN/FOCUS/… too, not just
//      concentration themes) across the last two semesters so they don't stack in one column.
// v42: inject the shared first-year engineering program for track pages whose plan grid
//      starts at "Second Year" (e.g. archived Coastal track) so the freshman year shows.
const PARSER_VERSION = 43; // v43: alias retired courses (MATH 253 → MATH 251)

/**
 * Get (or build) the degree requirement graph for a programId.
 * Uses in-memory cache → MongoDB cache → static file → scraper.
 *
 * @param {string} programId
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh] — skip all caches and rebuild
 * @returns {Promise<object>} graph
 */
async function getDegreeRequirementGraph(programId, opts = {}) {
  if (!programId) throw Object.assign(new Error('programId is required'), { statusCode: 400 });

  if (!opts.forceRefresh) {
    // 1. Memory cache
    const mem = getFromMemCache(programId);
    if (mem) return mem;

    // 2. MongoDB cache
    try {
      const doc = await DegreeRequirementGraph.findOne({ programId }).lean();
      const nodeCount = doc?.nodes?.length ?? 0;
      const hasPlaceholders = nodeCount > 0 && doc.nodes.some((n) => !n.code);
      const isCurrentVersion = doc?.parserVersion === PARSER_VERSION;
      if (doc && nodeCount > 0 && hasPlaceholders && isCurrentVersion) {
        const graph = mongoDocToGraph(doc);
        setMemCache(programId, graph);
        return graph;
      }
    } catch { /* non-fatal — continue to build */ }
  }

  // 3. Build from static plan
  const graph = await buildDegreeRequirementGraph(programId);

  // 4. Persist to MongoDB (best-effort, non-blocking)
  persistGraph(programId, graph).catch(() => {});

  setMemCache(programId, graph);
  return graph;
}

function mongoDocToGraph(doc) {
  return {
    programId:            doc.programId,
    catalog:              doc.catalog ?? null,
    title:                doc.title ?? '',
    sourceUrl:            doc.sourceUrl ?? null,
    nodes:                doc.nodes ?? [],
    edges:                doc.edges ?? [],
    flexibleRequirements: doc.flexibleRequirements ?? [],
    availableTracks:      doc.availableTracks ?? null,
    warnings:             doc.warnings ?? [],
    source:               doc.source ?? 'static',
  };
}

async function persistGraph(programId, graph) {
  await DegreeRequirementGraph.findOneAndUpdate(
    { programId },
    { ...graph, generatedAt: new Date(), parserVersion: PARSER_VERSION },
    { upsert: true, new: true }
  );
}

/**
 * Build (don't cache) the degree requirement graph for a programId.
 * Order: static plans → degreePlanId lookup → pre-built generated JSON → live catalog scrape.
 */
async function buildDegreeRequirementGraph(programId) {
  // 1. Try static plans (direct id match) — only for non-catalog IDs
  const plans = loadStaticPlans();
  let staticPlan = null;
  if (!programId.startsWith('catalog-major:')) {
    staticPlan = plans.find((p) => p.id === programId);
  }

  if (staticPlan) {
    return buildGraphFromStaticPlan(staticPlan);
  }

  // 3. Check pre-built generated-degree-graphs.json (from build-degree-graphs.mjs)
  const generated = loadGeneratedGraphs();
  if (generated[programId]) {
    return { ...generated[programId], programId };
  }

  // 4. Live catalog scrape for catalog-major: IDs
  if (programId.startsWith('catalog-major:')) {
    return scrapeGraphFromCatalog(programId);
  }

  // Unknown program
  return {
    programId, catalog: null, title: programId, sourceUrl: null,
    nodes: [], edges: [], flexibleRequirements: [],
    warnings: ['No degree plan data available for this program.'],
    source: 'static',
  };
}

/**
 * Load graphs for all majors in an academic profile.
 * Returns an object keyed by programId.
 *
 * @param {object} profile — AcademicProfile doc
 * @returns {Promise<{[programId: string]: object}>}
 */
async function getGraphForAcademicProfile(profile) {
  const ids = [];
  if (profile?.primaryMajor?.programId) ids.push(profile.primaryMajor.programId);
  for (const m of profile?.additionalMajors ?? []) if (m.programId) ids.push(m.programId);
  if (ids.length === 0) return {};
  const results = await Promise.allSettled(ids.map((id) => getDegreeRequirementGraph(id)));
  const out = {};
  for (let i = 0; i < ids.length; i++) {
    const r = results[i];
    out[ids[i]] = r.status === 'fulfilled' ? r.value : { programId: ids[i], nodes: [], edges: [], warnings: ['Failed to load graph.'], source: 'static' };
  }
  return out;
}

module.exports = {
  getDegreeRequirementGraph,
  buildDegreeRequirementGraph,
  scrapeGraphFromCatalog,
  parseCourseListAreas,
  parsePrerequisiteEdges,
  parseCorequisiteEdges,
  normalizeCourseCode,
  extractCourseCodes,
  getGraphForAcademicProfile,
  clearMemCache,
  invalidateGeneratedGraphsCache,
  parseCourseCatalogPage,
  fetchHtml,
  CATALOG_BASE,
};
