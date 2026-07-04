'use strict';
/**
 * degreeRequirementEvidence.js
 *
 * Interprets a built program graph (from degreeGraphBuilder) into a
 * structured requirement evidence bundle used by the classifier.
 *
 * Separation of concerns:
 *  - Degree requirement evidence --> source of truth for classification
 *  - Dependency graph edges     --> used only for prereq/coreq sequencing
 *
 * Evidence bundle shape:
 *  {
 *    programId, programTitle, catalog, hasData,
 *    exactRequiredCourses,   // specific courses that must be taken
 *    requiredChoiceGroups,   // student picks 1 option from a set (ENGL 103 or 104)
 *    pickNGroups,            // student picks N courses from a larger pool
 *    seniorDesignGroups,     // senior design / capstone requirements
 *    genericPlaceholders,    // Area Elective, UCC, etc. — do NOT create required evidence
 *    dependencyEdges,        // prereq/coreq edges from graph
 *    flexibleRequirements,   // graph-level flexible requirement metadata
 *    warnings,
 *  }
 */

const { equivalentCodes } = require('./crossListings');

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Labels that indicate a senior design / capstone requirement. */
const SENIOR_DESIGN_RE = /senior\s*(design|capstone|project)|capstone(\s*(design|project|course|sequence))?|design\s*project|computer\s*sys(tem)?s?\s*design|ecen\s*48[34]|csce\s*48[23]/i;

/**
 * Labels that indicate a generic placeholder (Area Elective, UCC, etc.)
 * These should NOT produce required course evidence.
 */
const PLACEHOLDER_RE = /^(area|engineering|technical|professional|free|science|general|track|emphasis|approved|required|elective|upper.?level|ucc|university|core|depth|breadth|advisor|additional)\s*(elective|electives|core|requirement|hours|credit|course)?s?$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeCode(raw) {
  const m = String(raw ?? '').toUpperCase().trim().match(/\b([A-Z]{3,5})\s+(\d{3}[A-Z]?)\b/);
  return m ? `${m[1]} ${m[2]}` : null;
}

function collectCodes(node) {
  const codes = new Set();
  if (node.code) {
    const c = normalizeCode(node.code);
    if (c) codes.add(c);
  }
  for (const m of node.matches ?? []) {
    const raw = typeof m === 'string' ? m : (m.code ?? '');
    const c = normalizeCode(raw);
    if (c) codes.add(c);
  }
  return [...codes];
}

function isGenericPlaceholder(node) {
  // No specific course code(s) at all
  if (!node.code && (node.matches?.length ?? 0) === 0) return true;
  // Title matches placeholder pattern
  const title = (node.title ?? '').trim();
  if (title && PLACEHOLDER_RE.test(title)) return true;
  return false;
}

function isSeniorDesignNode(node) {
  return (
    SENIOR_DESIGN_RE.test(node.title ?? '') ||
    SENIOR_DESIGN_RE.test(node.code ?? '') ||
    (node.matches ?? []).some((m) => SENIOR_DESIGN_RE.test(typeof m === 'string' ? m : (m.code ?? '')))
  );
}

// ---------------------------------------------------------------------------
// Core builder
// ---------------------------------------------------------------------------

/**
 * Given a program graph produced by degreeGraphBuilder, return a structured
 * requirement evidence bundle.
 *
 * @param {object} graph  — graph object from getDegreeRequirementGraph
 * @returns {object} evidence bundle
 */
function extractRequirementEvidence(graph, opts = {}) {
  const selectedTrackId = opts.selectedTrackId ?? null;
  const isTrackBased    = Array.isArray(graph?.availableTracks) && graph.availableTracks.length > 0;

  const programId    = graph?.programId ?? null;
  const programTitle = graph?.title     ?? null;
  const catalog      = graph?.catalog   ?? null;
  const hasData      = (graph?.nodes?.length ?? 0) > 0;

  if (!hasData) {
    return {
      programId,
      programTitle,
      catalog,
      hasData: false,
      exactRequiredCourses:  [],
      requiredChoiceGroups:  [],
      pickNGroups:           [],
      seniorDesignGroups:    [],
      pathOptionGroups:      [],
      genericPlaceholders:   [],
      dependencyEdges:       graph?.edges ?? [],
      flexibleRequirements:  graph?.flexibleRequirements ?? [],
      warnings:              graph?.warnings ?? [],
    };
  }

  const exactRequiredCourses = [];
  const requiredChoiceGroups = [];
  const pickNGroups          = [];
  const seniorDesignGroups   = [];
  const pathOptionGroups     = [];
  const genericPlaceholders  = [];

  for (const node of graph.nodes) {
    // Track gating — for single-page multi-track majors (e.g. BMEN), only nodes
    // belonging to the student's selected track (track_pool / track_required /
    // track_choice) contribute to classification, plus catch-all pools that apply to
    // any track. When no track is chosen, no track-scoped node counts.
    const isTrackScoped = typeof node.requirementSubtype === 'string'
      && node.requirementSubtype.startsWith('track_');
    if (isTrackBased && isTrackScoped && !node.isCatchAllPool) {
      if (!selectedTrackId || node.trackId !== selectedTrackId) continue;
    }

    const codes       = collectCodes(node);
    const isSenDes    = isSeniorDesignNode(node);
    const isPlacehld  = isGenericPlaceholder(node);
    const { requirementType } = node;

    // ── Area / track requirement pool (from the sc_courselist table) ──────────
    // Handled explicitly (and before the generic-placeholder check, whose title
    // pattern would otherwise swallow names like "BREADTH"/"FOCUS"): the pool's
    // course list is a real pick-N selection locked to those options.
    if ((node.requirementSubtype === 'area_pool' || node.requirementSubtype === 'track_pool') && codes.length > 0) {
      pickNGroups.push({
        id:           node.id,
        label:        node.title ?? 'Requirement Area',
        codes,
        pickCount:    node.pickCount ?? 1,
        creditHours:  node.requiredHours ?? node.creditHours ?? null,
        poolKind:     node.requirementSubtype,
        trackId:      node.trackId ?? null,
      });
      continue;
    }

    // ── Path option group: student must commit to one of N paths ──────────────
    // Supersedes everything — path_option nodes are identified by the graph builder
    // for requirements where the catalog defines mutually exclusive course paths
    // (e.g. CPEN Senior Design: ECEN 403+404 OR CSCE 483+Area Elective).
    if (requirementType === 'path_option') {
      const paths    = node.paths ?? [];
      const allCodes = [...new Set(paths.flatMap((p) => p.courses ?? []))];
      pathOptionGroups.push({
        id:          node.id,
        label:       node.title ?? 'Senior Design',
        paths,
        allCodes,
        creditHours: node.creditHours ?? null,
      });
      continue;
    }

    // ── Senior design detection (supersedes requirementType) ───────────────
    if (isSenDes) {
      // Even if the scraper gave this node type 'choice' or 'elective',
      // we know it's a senior design requirement group.
      const groupRule = codes.length === 1 ? 'required_single' : 'choose_one';
      seniorDesignGroups.push({
        id:           node.id,
        label:        node.title ?? (node.code ?? 'Senior Design/Capstone'),
        codes,
        groupRule,
        creditHours:  node.creditHours ?? null,
        confidence:   'high',
      });
      continue;
    }

    // ── Generic placeholder — store but don't use for required evidence ─────
    if (isPlacehld) {
      genericPlaceholders.push({
        id:           node.id,
        label:        node.title ?? 'Elective',
        requiredHours: node.creditHours ?? 0,
        requirementType,
      });
      continue;
    }

    // ── Exact required course ───────────────────────────────────────────────
    if (requirementType === 'required') {
      exactRequiredCourses.push({
        code:         node.code ?? null,
        allCodes:     codes,          // all cross-listed variants
        title:        node.title ?? '',
        creditHours:  node.creditHours ?? null,
        nodeId:       node.id,
      });
      continue;
    }

    // ── Required choice group (student picks one) ───────────────────────────
    if (requirementType === 'choice') {
      // Defensive: even for choice nodes, check there are no range strings in matches
      // (graph builder guarantees this, but guard for safety)
      const hasRanges = (node.matches ?? []).some((m) => /\d{3}-\d{3,4}/.test(String(m)));
      if (node.requirementSubtype === 'exact_compound_choice' && (node.alternatives?.length ?? 0) >= 2) {
        // Compound choice: some alternatives are required bundles (e.g. CHEM 228 + CHEM 238)
        // while others may be standalone courses (e.g. CHEM 258).  Preserve the alternatives
        // array so the classifier can apply bundle-aware logic.
        requiredChoiceGroups.push({
          id:           node.id,
          label:        node.title ?? (node.code ?? 'Choice Requirement'),
          codes,
          requiredCount: 1,
          groupRule:    'exact_compound_choice',
          creditHours:  node.creditHours ?? null,
          isExact:      true,
          isCompound:   true,
          alternatives: node.alternatives,  // [{type, courses, requiredTogether}]
        });
      } else {
        requiredChoiceGroups.push({
          id:           node.id,
          label:        node.title ?? (node.code ?? 'Choice Requirement'),
          codes,
          requiredCount: 1,
          groupRule:    'choose_one',
          creditHours:  node.creditHours ?? null,
          // isExact=true --> small explicit list of exact course codes, no ranges, not a broad pool
          // Classifier will promote the student's selected option to 'required'
          isExact:      codes.length >= 2 && !hasRanges,
        });
      }
      continue;
    }

    // ── Elective / flexible node ────────────────────────────────────────────
    if (requirementType === 'elective' || requirementType === 'flexible') {
      // If a specific course pool is named (e.g. pick 2 from a list), treat as pick-N
      if (codes.length >= 2) {
        pickNGroups.push({
          id:           node.id,
          label:        node.title ?? 'Elective Pool',
          codes,
          pickCount:    node.pickCount ?? 1,
          creditHours:  node.creditHours ?? null,
        });
      } else if (codes.length === 1) {
        // Single-code elective — treat like a required choice (prefer, don't force required)
        // isExact=false because this came from a broad/flexible pool, not an exact choice group
        requiredChoiceGroups.push({
          id:           node.id,
          label:        node.title ?? codes[0],
          codes,
          requiredCount: 1,
          groupRule:    'flexible_single',
          creditHours:  node.creditHours ?? null,
          isExact:      false,
        });
      } else {
        genericPlaceholders.push({
          id:           node.id,
          label:        node.title ?? 'Elective',
          requiredHours: node.creditHours ?? 0,
          requirementType,
        });
      }
      continue;
    }

    // ── Track / emphasis / other flexible types ─────────────────────────────
    if (['track', 'emphasis'].includes(requirementType)) {
      if (codes.length > 0) {
        pickNGroups.push({
          id:           node.id,
          label:        node.title ?? 'Track/Emphasis Elective',
          codes,
          pickCount:    node.pickCount ?? 1,
          creditHours:  node.creditHours ?? null,
        });
      } else {
        genericPlaceholders.push({
          id:           node.id,
          label:        node.title ?? 'Track/Emphasis',
          requiredHours: node.creditHours ?? 0,
          requirementType,
        });
      }
    }
  }

  return {
    programId,
    programTitle,
    catalog,
    hasData: true,
    exactRequiredCourses,
    requiredChoiceGroups,
    pickNGroups,
    seniorDesignGroups,
    pathOptionGroups,
    genericPlaceholders,
    dependencyEdges:      graph.edges ?? [],
    flexibleRequirements: graph.flexibleRequirements ?? [],
    warnings:             graph.warnings ?? [],
  };
}

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

/**
 * Match a course code string against a single evidence bundle.
 * Returns the best match, or null if no match.
 *
 * @param {string} courseCode   normalized "SUBJ NNN"
 * @param {object} evidence     bundle from extractRequirementEvidence
 * @returns {{ type, item, confidence } | null}
 */
function matchCourseToEvidence(courseCode, evidence) {
  const code = (courseCode ?? '').trim().toUpperCase();
  if (!code) return null;

  // Match against cross-listed equivalents too: a taken STAT 421 satisfies a
  // requirement listing CSCE 421 (same course, different department code).
  const codes = equivalentCodes(code);
  const hit = (arr) => (arr ?? []).some((c) => codes.includes(String(c).toUpperCase().trim()));

  // Priority 1 — exact required course
  for (const req of evidence.exactRequiredCourses) {
    if (hit(req.allCodes)) {
      return { type: 'exact_required', item: req, confidence: 'high' };
    }
  }

  // Priority 2 — path option group (catalog-defined mutually exclusive paths)
  for (const grp of evidence.pathOptionGroups ?? []) {
    for (const path of grp.paths) {
      if (hit(path.courses)) {
        return {
          type:        'path_option',
          item:        grp,
          pathId:      path.id,
          pathLabel:   path.label,
          pathCourses: path.courses,
          confidence:  'high',
        };
      }
    }
  }

  // Priority 3 — senior design / capstone group
  for (const grp of evidence.seniorDesignGroups) {
    if (hit(grp.codes)) {
      return { type: 'senior_design', item: grp, confidence: 'high' };
    }
  }

  // Priority 3 — required choice group (choose one from a set)
  for (const grp of evidence.requiredChoiceGroups) {
    if (hit(grp.codes)) {
      return { type: 'required_choice', item: grp, confidence: 'medium' };
    }
  }

  // Priority 4 — pick-N elective pool
  for (const grp of evidence.pickNGroups) {
    if (hit(grp.codes)) {
      return { type: 'pick_n', item: grp, confidence: 'medium' };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { extractRequirementEvidence, matchCourseToEvidence };
