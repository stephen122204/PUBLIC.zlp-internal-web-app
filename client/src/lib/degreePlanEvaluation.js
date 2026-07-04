/**
 * degreePlanEvaluation.js
 *
 * Client-side utilities for working with a student's semester plan
 * and a degree requirement graph.
 *
 * Used by StudentDegreePlanner and StudentFuturePlanning.
 */

// ---------------------------------------------------------------------------
// Flatten helpers
// ---------------------------------------------------------------------------

/** Returns all courses across all semesters */
export function flattenStudentCourses(semesters) {
  return (semesters ?? []).flatMap((s) => s.courses ?? []);
}

/** Returns courses whose semester status is 'completed' */
export function getCompletedCourses(semesters) {
  return (semesters ?? [])
    .filter((s) => s.status === 'completed')
    .flatMap((s) => s.courses ?? []);
}

/** Returns courses whose semester status is 'in_progress' */
export function getInProgressCourses(semesters) {
  return (semesters ?? [])
    .filter((s) => s.status === 'in_progress')
    .flatMap((s) => s.courses ?? []);
}

/** Returns courses whose semester status is 'planned' */
export function getPlannedCourses(semesters) {
  return (semesters ?? [])
    .filter((s) => s.status === 'planned')
    .flatMap((s) => s.courses ?? []);
}

// ---------------------------------------------------------------------------
// Cross-listed / equivalent courses
// ---------------------------------------------------------------------------
// The SAME course offered under multiple department codes — taking any one
// satisfies a requirement that lists another. Groups are generated from the TAMU
// catalog by scripts/build-cross-listings.mjs (formal cross-listings + identical-
// content equivalents like CSCE 421 / STAT 421). Re-run that script to refresh.
import crossListingData from '../data/crossListings.json';

const COURSE_EQUIVALENTS = (() => {
  const map = new Map();
  for (const group of crossListingData.groups ?? []) {
    const norm = group.map((c) => c.toUpperCase().trim());
    for (const code of norm) {
      const set = map.get(code) ?? new Set();
      for (const other of norm) if (other !== code) set.add(other);
      map.set(code, set);
    }
  }
  return map;
})();

/** A code plus all its cross-listed equivalents (all uppercase). */
export function equivalentCodes(code) {
  const up = String(code ?? '').toUpperCase().trim();
  return [up, ...(COURSE_EQUIVALENTS.get(up) ?? [])];
}

// ---------------------------------------------------------------------------
// Course state lookup
// ---------------------------------------------------------------------------

/**
 * Returns 'completed' | 'in_progress' | 'planned' | 'missing' for a given code.
 * Cross-listed equivalents count (e.g. a taken STAT 421 satisfies CSCE 421).
 * @param {string} code
 * @param {object[]} semesters
 */
export function getCourseState(code, semesters) {
  const wanted = equivalentCodes(code); // [self, ...cross-listed], all uppercase
  for (const sem of semesters ?? []) {
    const found = (sem.courses ?? []).some((c) => {
      const cc = String(c.code ?? '').toUpperCase().trim();
      if (wanted.includes(cc)) return true;
      const cm = (c.matches ?? []).map((m) => String(m).toUpperCase().trim());
      return cm.some((m) => wanted.includes(m));
    });
    if (found) return sem.status; // 'completed' | 'in_progress' | 'planned'
  }
  return 'missing';
}

/**
 * Returns the set of completed course codes (uppercase).
 * @param {object[]} semesters
 * @returns {Set<string>}
 */
export function getCompletedCodeSet(semesters) {
  const s = new Set();
  for (const sem of getCompletedCourses(semesters)) {
    s.add(String(sem.code ?? '').toUpperCase().trim());
    for (const m of sem.matches ?? []) s.add(String(m).toUpperCase().trim());
  }
  return s;
}

// ---------------------------------------------------------------------------
// Semester credit hours
// ---------------------------------------------------------------------------

/**
 * Returns the total credit hours for a single semester object.
 * @param {object} semester
 * @returns {number}
 */
export function computeSemesterCreditHours(semester) {
  return (semester?.courses ?? []).reduce((sum, c) => sum + (c.creditHours ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Prerequisite warnings
// ---------------------------------------------------------------------------

/**
 * Evaluate prereq warnings for a student's plan against a graph.
 *
 * Returns an array of warning objects:
 *   { type, code, missing, message }
 *
 * @param {object|null} graph — DegreeRequirementGraph
 * @param {object[]} semesters — student semester plan
 */
export function evaluatePrerequisiteWarnings(graph, semesters) {
  if (!graph || !semesters?.length) return [];

  const warnings = [];

  // Build an ordered map: semesterIndex --> Set of course codes in that semester
  const semesterCodeSets = (semesters ?? []).map((sem) => {
    const s = new Set();
    for (const c of sem.courses ?? []) {
      s.add(String(c.code ?? '').toUpperCase().trim());
      for (const m of c.matches ?? []) s.add(String(m).toUpperCase().trim());
    }
    return s;
  });

  // Build cumulative sets: after semester i, what codes are done?
  const cumulativeAfter = [];
  const running = new Set();
  for (let i = 0; i < semesters.length; i++) {
    const sem = semesters[i];
    if (sem.status === 'completed' || sem.status === 'in_progress') {
      for (const c of semesterCodeSets[i]) running.add(c);
    }
    cumulativeAfter.push(new Set(running));
  }

  // For each node in the graph that has prereqs
  for (const node of graph.nodes ?? []) {
    if (!node.prereqs?.length) continue;

    // Find which semester this course appears in
    let courseState = 'missing';
    let courseSemIndex = -1;
    for (let i = 0; i < semesters.length; i++) {
      if (semesterCodeSets[i].has(String(node.code ?? '').toUpperCase())) {
        courseState = semesters[i].status;
        courseSemIndex = i;
        break;
      }
    }

    if (courseState === 'missing') continue; // Not planned — no ordering warning

    // Check each prereq
    const completedBefore = courseSemIndex > 0 ? cumulativeAfter[courseSemIndex - 1] : new Set();

    for (const prereq of node.prereqs) {
      const prereqUpper = String(prereq).toUpperCase().trim();
      if (!completedBefore.has(prereqUpper)) {
        const prereqState = getCourseState(prereq, semesters);
        if (prereqState === 'missing') {
          warnings.push({
            type: 'missing_prereq',
            code: node.code,
            missing: prereq,
            message: `${node.code} requires ${prereq}, which is not in your plan.`,
          });
        } else if (prereqState === 'planned') {
          // Is the prereq planned before or after this course?
          let prereqSemIndex = -1;
          for (let i = 0; i < semesters.length; i++) {
            if (semesterCodeSets[i].has(prereqUpper)) { prereqSemIndex = i; break; }
          }
          if (prereqSemIndex >= courseSemIndex) {
            warnings.push({
              type: 'prereq_order',
              code: node.code,
              missing: prereq,
              message: `${node.code} is planned before its prerequisite ${prereq}.`,
            });
          }
        }
      }
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Graph node coloring (subject prefix --> color)
// ---------------------------------------------------------------------------

const SUBJECT_COLORS = {
  // Engineering & CS
  CSCE: '#2563eb',   // blue
  ECEN: '#991b1b',   // dark red / maroon
  MEEN: '#6d28d9',   // violet (mechanical)
  ISEN: '#475569',   // cool dark gray (industrial & systems)
  PETE: '#854d0e',   // dark amber (petroleum)
  AERO: '#1d4ed8',   // deep blue (aerospace)
  NUEN: '#0f766e',   // dark teal (nuclear)
  EVEN: '#166534',   // dark forest green (environmental)
  ENGR: '#4f46e5',   // indigo / purple (general engineering)
  // Mathematics & science
  MATH: '#16a34a',   // green
  PHYS: '#dc2626',   // red
  CHEM: '#ea580c',   // orange-red
  STAT: '#64748b',   // slate gray
  BIOL: '#15803d',   // dark green
  // Liberal arts / UCC core
  ENGL: '#d97706',   // amber
  COMM: '#d97706',   // amber (same family as ENGL)
  HIST: '#b45309',   // brown
  POLS: '#b45309',   // brown
  ECON: '#374151',   // near-black gray
  PHIL: '#9333ea',   // purple
  KINE: '#be123c',   // deep rose (kinesiology)
};

/**
 * Returns a deterministic border color for a subject prefix.
 * Known subjects use fixed colors; unknown subjects get a hue derived from their name.
 */
export function getSubjectColor(subject) {
  const upper = String(subject ?? '').toUpperCase().trim();
  if (SUBJECT_COLORS[upper]) return SUBJECT_COLORS[upper];
  // Deterministic fallback: derive hue from subject string to avoid gray-on-gray
  let hash = 0;
  for (let i = 0; i < upper.length; i++) hash = (Math.imul(31, hash) + upper.charCodeAt(i)) | 0;
  const hue = ((Math.abs(hash) % 300) + 30) % 360;
  return `hsl(${hue}, 60%, 38%)`;
}

/** Dedicated color for multi-option / equivalency-choice nodes (choose one of N courses). */
export const MULTI_OPTION_NODE_COLOR = '#0891b2'; // sky teal

/** Palette definitions for placeholder (elective/UCC) bucket nodes. */
export const PLACEHOLDER_PALETTES = {
  // University Core Curriculum component areas — a fixed degree requirement (amber).
  // Specific areas (American History, Creative Arts, …) all read as a generic "UCC" spot.
  ucc:     { border: '#f59e0b', bg: '#fffbeb', text: '#92400e', label: 'UCC' },
  // Free/unrestricted electives — visually distinct (indigo) from major-restricted slots.
  general: { border: '#6366f1', bg: '#eef2ff', text: '#3730a3', label: 'General Elective' },
  engr:    { border: '#ec4899', bg: '#fdf2f8', text: '#be185d', label: 'ENGR Elective' },
  comm:    { border: '#0d9488', bg: '#f0fdfa', text: '#0f766e', label: 'Comm. Elective' },
  area:    { border: '#3b82f6', bg: '#eff6ff', text: '#1e40af', label: 'Elective' },
};

/**
 * Returns the palette (border, bg, text, label, kicker) for a placeholder/elective bucket
 * node. The backend tags UCC component areas and general electives via `requirementSubtype`
 * ('ucc' / 'general_elective'); prefer that, falling back to title heuristics for older
 * cached graphs that predate the tagging.
 */
export function getPlaceholderPalette(title, requirementSubtype = null) {
  if (requirementSubtype === 'ucc')              return PLACEHOLDER_PALETTES.ucc;
  if (requirementSubtype === 'general_elective') return PLACEHOLDER_PALETTES.general;
  const t = String(title ?? '');
  if (/ucc|university\s*core/i.test(t))                  return PLACEHOLDER_PALETTES.ucc;
  if (/engr\s*elective|engineering\s*elective/i.test(t)) return PLACEHOLDER_PALETTES.engr;
  if (/comm(\.)?\s*elective|communication/i.test(t))     return PLACEHOLDER_PALETTES.comm;
  if (/\b(general|free|unrestricted)\s+electives?\b/i.test(t)) return PLACEHOLDER_PALETTES.general;
  return PLACEHOLDER_PALETTES.area;
}

/**
 * Full, tidy type label shown under the "ELECTIVE" kicker on a generic elective slot —
 * e.g. "Engineering elective" --> "ENGR Elective", "Area elective" --> "Area Elective",
 * "Advanced chemistry" --> "Advanced Chemistry". The name is shown in full (wrapping onto
 * multiple lines in a narrow box rather than being abbreviated); acronyms / subject codes
 * that are already all-caps (ECEN, DAEN, ENGR) are preserved.
 */
export function electiveDisplayLabel(title) {
  let t = String(title ?? '').trim();
  if (!t) return 'Elective';
  // Students recognize the engineering-elective slot as "ENGR Elective".
  t = t.replace(/engineering\s+elective/ig, 'ENGR Elective');
  return t
    .split(/\s+/)
    .map((w) => (/^[A-Z0-9]{2,}$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

/**
 * Returns true when a graph node represents an equivalency / multi-option choice
 * (e.g. "CSCE 305 / ECEN 360 / STAT 315") rather than one specific course.
 */
export function isMultiOptionNode(node) {
  if (!node?.code) return false;
  const code = String(node.code).trim();
  // Explicit slash: "CSCE 305 / ECEN 360 / STAT 315"
  if (code.includes('/')) return true;
  // matches from multiple different subject prefixes
  const matches = node.matches ?? [];
  if (matches.length > 0) {
    const codeSubj = code.split(' ')[0].toUpperCase();
    const subjects = new Set([codeSubj, ...matches.map((m) => String(m).split(' ')[0].toUpperCase())]);
    if (subjects.size >= 2) return true;
  }
  return false;
}

/**
 * Returns the single semantic color (border + course-code text) for a graph node.
 * Multi-option grouped nodes --> MULTI_OPTION_NODE_COLOR.
 * Single-course nodes --> subject prefix color via getSubjectColor.
 */
export function getNodeSemanticColor(node) {
  if (isMultiOptionNode(node)) return MULTI_OPTION_NODE_COLOR;
  const subj = node.subject ?? String(node.code ?? '').split(' ')[0] ?? '';
  return getSubjectColor(subj);
}

/**
 * Convert a column ID (e.g. "y1f", "y2s") to a human-readable label.
 * Handles patterns: y1f --> "Year 1 Fall", col-0 --> "Semester 1", bare number --> "Semester N".
 */
export function columnIdToLabel(colId) {
  if (colId == null) return 'Other';
  const s = String(colId).trim();
  const m = s.match(/^y(\d+)(su|sm|sp?|f)$/i);
  if (m) {
    const seasons = { f: 'Fall', s: 'Spring', sp: 'Spring', su: 'Summer', sm: 'Summer' };
    return `Year ${m[1]} ${seasons[m[2].toLowerCase()] ?? m[2].toUpperCase()}`;
  }
  const col = s.match(/^col-?(\d+)$/i);
  if (col) return `Semester ${Number(col[1]) + 1}`;
  if (/^\d+$/.test(s)) return `Semester ${s}`;
  return s;
}

/**
 * Infer column placement for graph nodes using topological layering (longest-path from sources).
 * Used when nodes lack a semesterColumn value. Returns Map<nodeId, colIndex>.
 *
 * @param {object[]} nodes
 * @param {object[]} edges
 * @returns {Map<string, number>} nodeId --> column index
 */
export function inferColumnLayout(nodes, edges) {
  const allIds   = new Set();
  const codeToId = new Map();
  for (const n of nodes) {
    const id = n.id ?? n.code;
    allIds.add(id);
    codeToId.set(String(n.code ?? id).toUpperCase(), id);
    for (const m of n.matches ?? []) codeToId.set(String(m).toUpperCase(), id);
  }

  const adj      = new Map(); // id --> downstream ids
  const indegree = new Map();
  for (const id of allIds) { adj.set(id, []); indegree.set(id, 0); }

  for (const e of edges ?? []) {
    if (e.type !== 'prerequisite') continue;
    const srcId = codeToId.get(String(e.from ?? '').toUpperCase());
    const tgtId = codeToId.get(String(e.to   ?? '').toUpperCase());
    if (!srcId || !tgtId || srcId === tgtId) continue;
    adj.get(srcId)?.push(tgtId);
    indegree.set(tgtId, (indegree.get(tgtId) ?? 0) + 1);
  }

  // Kahn's algorithm with longest-path (critical path) layer assignment
  const layer = new Map();
  const queue = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) { queue.push(id); layer.set(id, 0); }
  }
  let head = 0;
  while (head < queue.length) {
    const cur      = queue[head++];
    const curLayer = layer.get(cur) ?? 0;
    for (const nxt of (adj.get(cur) ?? [])) {
      layer.set(nxt, Math.max(layer.get(nxt) ?? 0, curLayer + 1));
      indegree.set(nxt, (indegree.get(nxt) ?? 1) - 1);
      if (indegree.get(nxt) === 0) queue.push(nxt);
    }
  }
  // Handle unvisited nodes (cycle members or isolated)
  for (const id of allIds) { if (!layer.has(id)) layer.set(id, 0); }
  return layer;
}
