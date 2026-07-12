'use strict';
/**
 * courseClassifier.js
 *
 * System Classification Engine — v2-requirement-evidence
 *
 * Classifies student course requests as:
 *   required | preferred | not_applied | unclassified
 *
 * Classification is driven by structured degree requirement evidence
 * (exactRequiredCourses, seniorDesignGroups, requiredChoiceGroups, pickNGroups)
 * extracted from program graphs.  The dependency graph is used only for
 * prerequisite / corequisite sequencing — NOT as the sole classification source.
 *
 * Admin manual overrides are preserved in finalClassification.
 *
 * Priority order:
 *  1. Missing academic profile / no programs       --> unclassified
 *  2. No non-empty evidence for any program        --> unclassified
 *  3. Offering confirmed NOT available             --> not_applied
 *  4. Course already completed/passed              --> not_applied
 *  5. Exact required course match (major only)     --> required*
 *  6. Exact required course match (minor program)  --> preferred (minors never force-required)
 *  7. Senior design/capstone requirement match     --> required (single) / preferred (choice)
 *  8. Student-selected option from exact required
 *     choice/equivalency group (isExact=true)      --> required (first/only); preferred if duplicate
 *  9. Required choice group match (isExact=false)  --> preferred (broad/flexible pool)
 * 10. Pick-N elective pool match                   --> preferred
 * 11. Student semester plan only                   --> preferred
 * 12. No match                                     --> preferred (may count as elective)
 *
 * *required is demoted to not_applied when prerequisites are confirmed missing.
 */

const CLASSIFIER_VERSION = 'v2-requirement-evidence';

const StudentAcademicProfile = require('../models/StudentAcademicProfile');
const StudentCourseRequest   = require('../models/StudentCourseRequest');
const StudentSemesterPlan    = require('../models/StudentSemesterPlan');
const StudentPlannedCourse   = require('../models/StudentPlannedCourse');
const SchedulingCycle        = require('../models/SchedulingCycle');
const Cohort                 = require('../models/Cohort');
const User                   = require('../models/User');
const { getDegreeRequirementGraph }           = require('./degreeGraphBuilder');
const { extractRequirementEvidence,
        matchCourseToEvidence }               = require('./degreeRequirementEvidence');
const { getCourseSections }                   = require('./courseSections');
const { equivalentCodes }                     = require('./crossListings');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeCode(subject, number) {
  return `${String(subject ?? '').trim().toUpperCase()} ${String(number ?? '').trim()}`;
}

function parseCourseCode(code) {
  const parts = String(code ?? '').trim().split(/\s+/);
  return { subject: parts[0] ?? '', number: parts[1] ?? '' };
}

// ---------------------------------------------------------------------------
// Seminar / lab course-type detection helpers
// ---------------------------------------------------------------------------

/** Matches seminar-style course titles.  Credit hours alone are NOT sufficient. */
const SEMINAR_TITLE_RE = /\bseminar\b|\bcolloquium\b/i;

/** Matches lab/recitation-style titles — these are protected from seminar downgrade. */
const LAB_TITLE_RE = /\blab(oratory)?\b|\brecitation\b|\bdesign\s*lab\b|\bproject\s*lab\b/i;

/**
 * Returns true only when the course title or requirement-node title/code text
 * contains seminar/colloquium keywords.  Credit hours are NOT used here.
 *
 * @param {object} courseRequest  StudentCourseRequest doc (may have .title)
 * @param {object} matchItem      exactRequiredCourses evidence item (.title, .code)
 */
function isSeminarLikeCourse(courseRequest, matchItem) {
  const texts = [
    courseRequest?.title ?? '',
    matchItem?.title ?? '',
    matchItem?.code  ?? '',
  ];
  return texts.some((t) => SEMINAR_TITLE_RE.test(t));
}

/**
 * Returns true when the course or node title contains lab/recitation keywords.
 * Lab-like courses should NOT be downgraded by the seminar rule even if
 * they are low-credit.
 *
 * @param {object} courseRequest  StudentCourseRequest doc
 * @param {object} matchItem      exactRequiredCourses evidence item
 */
function isLabLikeCourse(courseRequest, matchItem) {
  const texts = [
    courseRequest?.title ?? '',
    matchItem?.title ?? '',
  ];
  return texts.some((t) => LAB_TITLE_RE.test(t));
}

/**
 * Returns true if this course appears as a listed prerequisite for any
 * required course in the program graph or dependency-edge set.
 *
 * A seminar that is prereq-chain-critical is NOT downgraded because removing
 * it would block a future required course.
 *
 * @param {string} courseCode   normalized "SUBJ NNN"
 * @param {object} graph        program graph from getDegreeRequirementGraph
 * @param {object} ev           evidence bundle (has .dependencyEdges, .exactRequiredCourses)
 */
function isPrereqChainCritical(courseCode, graph, ev) {
  if (!graph) return false;
  const code = courseCode.trim().toUpperCase();

  // Check 1: course appears in .prereqs[] of any required graph node
  for (const node of graph.nodes ?? []) {
    if (node.requirementType !== 'required') continue;
    const listed = (node.prereqs ?? []).some((p) => {
      const pc = typeof p === 'string'
        ? normalizeCode(...p.trim().split(/\s+/))
        : normalizeCode(p.subject ?? '', p.number ?? '');
      return pc === code;
    });
    if (listed) return true;
  }

  // Check 2: dependency edge points FROM this course TO a required course
  const requiredCodeSet = new Set(
    (ev?.exactRequiredCourses ?? []).flatMap((r) => r.allCodes ?? [])
  );
  for (const edge of ev?.dependencyEdges ?? []) {
    const fromCode = normalizeCode(...String(edge.from ?? edge.source ?? '').split(/\s+/));
    const toCode   = normalizeCode(...String(edge.to   ?? edge.target ?? '').split(/\s+/));
    if (fromCode === code && requiredCodeSet.has(toCode)) return true;
  }

  return false;
}

/**
 * Build a set of course codes from an array of planned-course docs.
 */
function buildCodeSet(courses) {
  // Include cross-listed equivalents so a taken STAT 421 also satisfies anything
  // keyed on CSCE 421 (prereq checks, already-completed detection, path commitment).
  const set = new Set();
  for (const c of courses) {
    for (const e of equivalentCodes(normalizeCode(c.subject, c.number))) set.add(e);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Phase 5 — Offering availability
// ---------------------------------------------------------------------------

/**
 * Check whether a course is offered for the active cycle term.
 * Returns { offered: true|false|null, sectionCount, warnings }
 * offered=null means unknown.
 */
async function evaluateOfferingAvailability(course, activeCycle) {
  const warnings = [];

  if (!activeCycle?.termCode) {
    return { offered: null, sectionCount: 0, warnings: ['No active cycle termCode; offering availability unknown.'] };
  }

  const { subject, number } = parseCourseCode(course.code);
  try {
    const sections = await getCourseSections(subject, number, activeCycle.termCode);
    const offered = sections.length > 0;
    return { offered, sectionCount: sections.length, warnings };
  } catch (err) {
    warnings.push(`Offering availability could not be verified: ${err.message}`);
    return { offered: null, sectionCount: 0, warnings };
  }
}

// ---------------------------------------------------------------------------
// Phase 7/8 — Graph matching helpers
// ---------------------------------------------------------------------------

/**
 * Collect all code strings a graph node can match:
 *   node.code + node.matches[]
 */
function getNodeCodes(node) {
  const codes = new Set();
  if (node.code) codes.add(normalizeCode(...node.code.split(/\s+/)));
  for (const m of node.matches ?? []) {
    const mCode = typeof m === 'string' ? m : (m.code ?? '');
    if (mCode) codes.add(normalizeCode(...mCode.split(/\s+/)));
  }
  return codes;
}

/**
 * Find all graph nodes matching a course code.
 */
function findMatchingNodes(courseCode, graph) {
  const code = normalizeCode(...(courseCode.split(/\s+/)));
  return (graph?.nodes ?? []).filter((n) => {
    if (!n.code && (n.matches ?? []).length === 0) return false;
    return getNodeCodes(n).has(code);
  });
}

// ---------------------------------------------------------------------------
// Phase 6 — Required course matching
// ---------------------------------------------------------------------------

function classifyCourseAgainstProgram(courseCode, programGraph) {
  const nodes = findMatchingNodes(courseCode, programGraph);
  if (nodes.length === 0) return null;

  const requiredNodes  = nodes.filter((n) => n.requirementType === 'required');
  const flexibleNodes  = nodes.filter((n) => ['choice', 'elective', 'flexible', 'track', 'emphasis'].includes(n.requirementType));

  if (requiredNodes.length > 0) {
    return { classification: 'required', nodes: requiredNodes, isFlexible: false };
  }
  if (flexibleNodes.length > 0) {
    return { classification: 'preferred', nodes: flexibleNodes, isFlexible: true };
  }
  // matched but unknown type
  return { classification: 'preferred', nodes, isFlexible: true };
}

// ---------------------------------------------------------------------------
// Phase 7 — Flexible requirement: check if only viable option --> required
// ---------------------------------------------------------------------------

/**
 * For each flexible/choice group node the course matches, check if all
 * other choices in that group are NOT viable (not offered, etc.).
 * If so, the course is the only viable option --> required.
 *
 * This is conservative: we only promote if we can confidently determine
 * all alternatives are not offered. Unknown offering --> stay as preferred.
 */
async function evaluateFlexibleRequirementMatch(courseCode, graph, activeCycle, completedCodes) {
  const matched = findMatchingNodes(courseCode, graph).filter((n) =>
    ['choice', 'elective', 'flexible', 'track', 'emphasis'].includes(n.requirementType)
  );

  if (matched.length === 0) return { promoted: false };

  // For each matched flexible node, check if there is a pickCount/group
  // and whether all sibling choices are unavailable.
  // Implementation: look at flexibleRequirements groups for matches.
  for (const flexGroup of graph.flexibleRequirements ?? []) {
    const groupCodes = (flexGroup.courses ?? []).map((c) =>
      typeof c === 'string' ? normalizeCode(...c.split(/\s+/)) : normalizeCode(c.subject ?? '', c.number ?? '')
    );
    const courseNorm = normalizeCode(...courseCode.split(/\s+/));
    if (!groupCodes.includes(courseNorm)) continue;

    // Check if the student already completed this requirement
    const alreadySatisfied = groupCodes.some((c) => completedCodes.has(c));
    if (alreadySatisfied) continue; // group already done

    // Check viability of all siblings
    const siblings = groupCodes.filter((c) => c !== courseNorm);
    if (siblings.length === 0) {
      // Only option in the group
      return { promoted: true, reason: 'Only option in flexible requirement group.' };
    }

    let allSiblingsUnavailable = true;
    for (const sib of siblings) {
      const { subject, number } = parseCourseCode(sib);
      try {
        const sections = await getCourseSections(subject, number, activeCycle?.termCode ?? '');
        if (sections.length > 0) { allSiblingsUnavailable = false; break; }
      } catch {
        // Unknown — do not promote
        allSiblingsUnavailable = false;
        break;
      }
    }

    if (allSiblingsUnavailable) {
      return { promoted: true, reason: 'Only offered option for a required flexible requirement this term.' };
    }
  }

  return { promoted: false };
}

// ---------------------------------------------------------------------------
// Phase 8 — Prerequisite eligibility
// ---------------------------------------------------------------------------

/**
 * A course is eligible if all its prerequisite nodes in the graph are:
 *   completed, or corequisite (concurrent), or in-progress (acceptable).
 *
 * Returns { eligible: true|false|null, missingPrereqs, warnings }
 * null = unknown (no graph edge data)
 */
function evaluatePrerequisiteEligibility(courseCode, graph, completedCodes, inProgressCodes) {
  const nodes = findMatchingNodes(courseCode, graph);
  if (nodes.length === 0) return { eligible: null, missingPrereqs: [], warnings: [] };

  const warnings = [];
  const missingPrereqs = [];

  for (const node of nodes) {
    const prereqs = node.prereqs ?? [];
    for (const prereq of prereqs) {
      const prereqCode = typeof prereq === 'string' ? normalizeCode(...prereq.split(/\s+/)) : normalizeCode(prereq.subject ?? '', prereq.number ?? '');
      if (!prereqCode) continue;
      const done = completedCodes.has(prereqCode);
      const inProg = inProgressCodes.has(prereqCode);
      if (!done && !inProg) {
        missingPrereqs.push(prereqCode);
      }
    }
    // Coreqs are concurrent — don't block eligibility
  }

  if (missingPrereqs.length > 0) {
    warnings.push(`Missing prerequisites: ${missingPrereqs.join(', ')}`);
    return { eligible: false, missingPrereqs, warnings };
  }

  return { eligible: true, missingPrereqs: [], warnings: [] };
}

// ---------------------------------------------------------------------------
// Path commitment detection
// ---------------------------------------------------------------------------

/**
 * Given a list of path definitions and the student's active course codes
 * (completed + planned), return the path whose courses are ALL present.
 * Returns null if no single path is fully committed.
 */
// First path whose courses are ALL present in `activeCodes` (completed ∪ planned
// ∪ requested) — i.e. the path the student has effectively committed to. Returns
// null when no path is fully satisfied yet.
function detectCommittedPath(paths, activeCodes) {
  for (const path of paths ?? []) {
    const courses = path.courses ?? [];
    if (courses.length > 0 && courses.every((c) => activeCodes.has(c))) {
      return path;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase 4 — Build classification context
// ---------------------------------------------------------------------------

async function buildClassificationContext({ userId, cohortId, schedulingCycleId }) {
  // Load all dependencies in parallel
  const [user, cohort, cycle, academicProfile, semesterPlans, courseRequests] = await Promise.all([
    User.findById(userId).lean(),
    Cohort.findById(cohortId).lean(),
    schedulingCycleId
      ? SchedulingCycle.findById(schedulingCycleId).lean()
      : Promise.resolve(null),
    StudentAcademicProfile.findOne({ userId, cohortId }).lean(),
    StudentSemesterPlan.find({ userId, cohortId }).lean(),
    StudentCourseRequest.find({ userId, cohortId, ...(schedulingCycleId ? { schedulingCycleId } : {}) }).lean(),
  ]);

  // Load all planned courses for all semesters
  let allPlannedCourses = [];
  if (semesterPlans.length > 0) {
    const semIds = semesterPlans.map((s) => s._id);
    allPlannedCourses = await StudentPlannedCourse.find({
      userId,
      cohortId,
      semesterPlanId: { $in: semIds },
    }).lean();
  }

  // Categorize planned courses
  const completedCourses  = allPlannedCourses.filter((c) => c.status === 'completed');
  const inProgressCourses = allPlannedCourses.filter((c) => c.status === 'in_progress');
  const plannedCourses    = allPlannedCourses.filter((c) => c.status === 'planned');

  const completedCodes  = buildCodeSet(completedCourses);
  const inProgressCodes = buildCodeSet(inProgressCourses);
  const plannedCodes    = buildCodeSet(plannedCourses);
  // Transfer credit is earned elsewhere — only Texas A&M courses are scheduled,
  // so any request matching a transfer course is classified not_applied.
  const transferCodes   = buildCodeSet(allPlannedCourses.filter((c) => c.transfer === true));

  // Load degree graphs for each program in the academic profile
  const programGraphs  = {};
  const programEvidence = {};
  const graphWarnings  = [];  // RUN-LEVEL warnings — not copied to individual courses

  // Use draft overlay — same effective major the student sees and that gets snapshotted on submit
  const draft = academicProfile?.studentDraft;
  const effectivePrimaryMajor     = draft?.primaryMajor     ?? academicProfile?.primaryMajor     ?? null;
  const effectiveAdditionalMajors = draft?.additionalMajors ?? academicProfile?.additionalMajors ?? [];
  const effectiveMinors           = draft?.minors           ?? academicProfile?.minors           ?? [];

  const programs = [
    ...(effectivePrimaryMajor ? [effectivePrimaryMajor] : []),
    ...effectiveAdditionalMajors,
    ...effectiveMinors,
  ];

  await Promise.allSettled(
    programs.map(async (prog) => {
      if (!prog.programId) return;
      try {
        const graph = await getDegreeRequirementGraph(prog.programId);
        programGraphs[prog.programId]    = graph;
        // Single-page multi-track majors (e.g. BMEN): only the student's selected
        // track pool contributes to classification.
        programEvidence[prog.programId]  = extractRequirementEvidence(graph, {
          selectedTrackId: prog.selectedTrackId ?? null,
        });

        if ((graph.nodes?.length ?? 0) === 0) {
          graphWarnings.push(
            `${prog.title ?? prog.programId} requirement data is unavailable; classifications use available major requirements.`
          );
        } else {
          // Pass through only critical graph-build warnings (cap at 2 per program)
          const critical = (graph.warnings ?? []).filter((w) => /error|failed|could not/i.test(w));
          for (const w of critical.slice(0, 2)) {
            graphWarnings.push(`${prog.title ?? prog.programId}: ${w}`);
          }
        }
      } catch (err) {
        graphWarnings.push(`Could not load requirements for ${prog.title ?? prog.programId}: ${err.message}`);
      }
    })
  );

  const minorProgramIds = new Set(
    effectiveMinors.map((m) => m.programId).filter(Boolean)
  );

  return {
    user,
    cohort,
    activeCycle: cycle,
    academicProfile,
    programGraphs,
    programEvidence,
    programs,
    minorProgramIds,
    semesterPlans,
    completedCourses,
    inProgressCourses,
    plannedCourses,
    completedCodes,
    inProgressCodes,
    plannedCodes,
    transferCodes,
    courseRequests,
    graphWarnings,  // run-level only
  };
}

// ---------------------------------------------------------------------------
// Phase 3 — Core classifier: classifyCourseRequest (evidence-driven)
// ---------------------------------------------------------------------------

async function classifyCourseRequest(courseRequest, context) {
  const {
    academicProfile,
    programGraphs,
    programEvidence,
    programs,
    minorProgramIds,
    activeCycle,
    completedCodes,
    inProgressCodes,
    plannedCodes,
    transferCodes,
    exactChoiceGroupMap,
    // graphWarnings intentionally NOT used here — they are run-level only
  } = context;

  // Course-specific warnings only (prereq, offering issues for THIS course)
  const warnings = [];
  // evidence — enriched with a categoryMatches map for developer inspection.
  // categoryMatches keys: exactRequired | pathOption | seniorDesign | requiredChoice | pickN
  // Each entry records whether the category was checked and what (if anything) it matched.
  const evidence = {
    matchedPrograms:    [],
    matchedNodes:       [],
    categoryMatches:    {}, // dev-only — keyed by programId
    offering:           {},
    prerequisiteStatus: {},
    source:             'missing_data',
  };

  const code = normalizeCode(courseRequest.subject, courseRequest.number);

  // ── 0. Excluded courses — never inserted into the scheduling algorithm ──
  // These courses are classified as not_applied regardless of all other checks.
  const ALGORITHM_EXCLUDED_COURSES = new Set([
    'ENGR 251', 'ENGR 350', 'ENGR 351', 'ENGR 450', 'ENGR 451',
  ]);
  if (ALGORITHM_EXCLUDED_COURSES.has(code)) {
    return {
      systemClassification: 'not_applied',
      reason:   `${code} is excluded from the scheduling algorithm and will not be inserted.`,
      warnings,
      evidence: { ...evidence, source: 'excluded_course' },
    };
  }

  // ── 0b. Transfer credit --> not_applied ──────────────────────────────────
  // Transfer credit is earned outside Texas A&M; only A&M courses are scheduled,
  // so a request matching a transfer course is never inserted, regardless of any
  // other check.
  if (transferCodes.has(code)) {
    return {
      systemClassification: 'not_applied',
      reason:   `${code} is transfer credit; only Texas A&M courses are scheduled.`,
      warnings,
      evidence: { ...evidence, source: 'transfer_credit' },
    };
  }

  // ── 1. Missing data checks ─────────────────────────────────────────────
  if (!academicProfile) {
    return {
      systemClassification: 'unclassified',
      reason:   'Classification pending: no academic profile selected.',
      warnings,
      evidence: { ...evidence, source: 'missing_data' },
    };
  }

  if (!activeCycle) {
    warnings.push('No active scheduling cycle; offering availability not checked.');
  }

  if (programs.length === 0) {
    return {
      systemClassification: 'unclassified',
      reason:   'Classification pending: no programs selected in academic profile.',
      warnings,
      evidence: { ...evidence, source: 'missing_data' },
    };
  }

  const hasAnyNonEmptyEvidence = Object.values(programEvidence).some((e) => e?.hasData);
  if (!hasAnyNonEmptyEvidence) {
    return {
      systemClassification: 'unclassified',
      reason:   'Classification pending: degree requirement data is not yet available for the selected program.',
      warnings,
      evidence: { ...evidence, source: 'missing_data' },
    };
  }

  // ── 2. Offering availability ────────────────────────────────────────────
  const offeringResult = activeCycle
    ? await evaluateOfferingAvailability(courseRequest, activeCycle)
    : { offered: null, sectionCount: 0, warnings: [] };
  evidence.offering = offeringResult;
  warnings.push(...offeringResult.warnings);

  if (offeringResult.offered === false) {
    return {
      systemClassification: 'not_applied',
      reason:   `${code} is not offered for the active registration term (${activeCycle.termCode}).`,
      warnings,
      evidence: { ...evidence, source: 'offering_check' },
    };
  }

  // ── 3. Already completed --> not_applied ─────────────────────────────────
  if (completedCodes.has(code)) {
    return {
      systemClassification: 'not_applied',
      reason:   `${code} already appears as completed in the degree planner.`,
      warnings,
      evidence: { ...evidence, source: 'student_plan' },
    };
  }

  // ── 4–8. Match against requirement evidence bundles ─────────────────────
  // Priority: primary major first (first program in list), then others.
  let bestClassification = null;
  let bestReason         = '';
  let bestSource         = 'degree_requirement';

  for (const prog of programs) {
    const ev = programEvidence[prog.programId];
    const progTitle = ev?.programTitle ?? prog.title ?? prog.programId;

    // Record per-program evidence summary for dev drawer (even when no match found)
    const catEntry = {
      programId:    prog.programId,
      programTitle: progTitle,
      hasData:      ev?.hasData ?? false,
      exactRequired:   { checked: false, matched: false, item: null },
      pathOption:      { checked: false, matched: false, item: null },
      seniorDesign:    { checked: false, matched: false, item: null },
      requiredChoice:  { checked: false, matched: false, item: null },
      pickN:           { checked: false, matched: false, item: null },
      graphNodeMatch:  false,
    };
    evidence.categoryMatches[prog.programId] = catEntry;

    if (!ev || !ev.hasData) continue;  // skip programs with no evidence

    // Populate category presence counts (for drawer context)
    catEntry.exactRequired.checked  = ev.exactRequiredCourses.length > 0;
    catEntry.pathOption.checked     = (ev.pathOptionGroups ?? []).length > 0;
    catEntry.seniorDesign.checked   = ev.seniorDesignGroups.length > 0;
    catEntry.requiredChoice.checked = ev.requiredChoiceGroups.length > 0;
    catEntry.pickN.checked          = ev.pickNGroups.length > 0;

    // Check exact required
    const exactHit = ev.exactRequiredCourses.find((r) => r.allCodes.includes(code));
    if (exactHit) catEntry.exactRequired = { ...catEntry.exactRequired, matched: true, item: { code: exactHit.code, allCodes: exactHit.allCodes } };

    // Check path option
    let pathHit = null;
    for (const grp of ev.pathOptionGroups ?? []) {
      for (const path of grp.paths) {
        if ((path.courses ?? []).includes(code)) { pathHit = { groupLabel: grp.label, pathLabel: path.label, pathId: path.id }; break; }
      }
      if (pathHit) break;
    }
    if (pathHit) catEntry.pathOption = { ...catEntry.pathOption, matched: true, item: pathHit };

    // Check senior design
    const sdHit = ev.seniorDesignGroups.find((g) => g.codes.includes(code));
    if (sdHit) catEntry.seniorDesign = { ...catEntry.seniorDesign, matched: true, item: { label: sdHit.label, groupRule: sdHit.groupRule } };

    // Check required choice
    const rcHit = ev.requiredChoiceGroups.find((g) => g.codes.includes(code));
    if (rcHit) catEntry.requiredChoice = { ...catEntry.requiredChoice, matched: true, item: { label: rcHit.label, codes: rcHit.codes, isExact: rcHit.isExact } };

    // Check pick-N
    const pnHit = ev.pickNGroups.find((g) => g.codes.includes(code));
    if (pnHit) catEntry.pickN = { ...catEntry.pickN, matched: true, item: { label: pnHit.label, pickCount: pnHit.pickCount } };

    const match = matchCourseToEvidence(code, ev);
    if (!match) continue;

    evidence.matchedPrograms.push(prog.programId);

    // Prerequisite eligibility — graph-based, for sequencing info only
    const graph = programGraphs[prog.programId];
    if (graph) {
      catEntry.graphNodeMatch = findMatchingNodes(code, graph).length > 0;
      const prereqResult = evaluatePrerequisiteEligibility(code, graph, completedCodes, inProgressCodes);
      evidence.prerequisiteStatus = prereqResult;
      warnings.push(...prereqResult.warnings);  // course-specific prereq warnings
    }

    if (match.type === 'exact_required') {
      // ── Priority 4: Exact required course ────────────────────────────────
      const isMinorProgram = minorProgramIds.has(prog.programId);

      if (isMinorProgram) {
        // Minor courses are capped at preferred — never force-required
        evidence.matchedNodes.push({
          programId:       prog.programId,
          matchType:       'exact_required',
          nodeCode:        match.item.code,
          requirementType: 'required',
          source:          'requirement_table',
        });
        if (!bestClassification || bestClassification === 'not_applied') {
          bestClassification = 'preferred';
          bestReason = `Preferred: ${code} is a required course for the ${progTitle} minor.`;
          bestSource = 'requirement_table';
        }
      } else {
        // ── Seminar downgrade check (runs before generic required assignment) ──
        // A seminar-like course that is NOT lab-like is treated as a flexible ZLP
        // preference rather than a required constraint, even if it is prereq-chain-
        // critical (the algorithm will still schedule it when requested).
        const seminarLike         = isSeminarLikeCourse(courseRequest, match.item);
        const labLike             = isLabLikeCourse(courseRequest, match.item);
        const prereqChainCritical = false; // ignored for seminar downgrade — all seminars are preferred
        const seminarDowngradeApplied = seminarLike && !labLike;

        evidence.matchedNodes.push({
          programId:              prog.programId,
          matchType:              'exact_required',
          nodeCode:               match.item.code,
          requirementType:        'required',
          source:                 'requirement_table',
          seminarLike,
          labLike,
          seminarDowngradeApplied,
          prereqChainCritical,
          creditHours:            match.item.creditHours ?? courseRequest.creditHours ?? null,
        });

        if (seminarDowngradeApplied) {
          // Seminar downgrade: classify as preferred unless a later program
          // still finds this course as a plain required (non-seminar) match.
          if (!bestClassification || bestClassification === 'not_applied') {
            bestClassification = 'preferred';
            bestReason = `Preferred: ${code} appears as a required seminar course in ${progTitle}, but seminar-style courses are treated as flexible ZLP preferences rather than required constraints.`;
            bestSource = 'seminar_downgrade';
          }
        } else {
          bestClassification = 'required';
          bestReason = `Required: ${code} is a required course in ${progTitle}.`;
          bestSource = 'requirement_table';
          break;  // required from any program wins immediately
        }
      }

    } else if (match.type === 'path_option') {
      // ── Path option: catalog-defined mutually exclusive paths ────────────────
      // The student commits to ONE path. If a DIFFERENT path is fully satisfied
      // (all its courses completed/planned/requested), then this course meets the
      // SAME senior-design requirement that the committed path already covers —
      // so it's redundant and classified not_applied.
      //   e.g. CPEN: CSCE 483 (+ area elective) committed ⇒ ECEN 403/404 not_applied;
      //        ECEN 403 + 404 committed ⇒ CSCE 483 not_applied.
      const requestedCodes = new Set(
        context.courseRequests.map((r) => {
          const s  = (r.subject ?? '').toUpperCase().trim();
          const n2 = (r.number ?? '').toUpperCase().trim();
          return s && n2 ? `${s} ${n2}` : (r.courseCode ?? '');
        }).filter(Boolean)
      );
      const activeForPath = new Set([...completedCodes, ...plannedCodes, ...requestedCodes]);
      const committedPath = detectCommittedPath(match.item.paths ?? [], activeForPath);

      if (committedPath && committedPath.id !== match.pathId) {
        // Another path satisfies this requirement — this course's path is redundant.
        evidence.matchedNodes.push({
          programId:   prog.programId,
          matchType:   'path_option',
          label:       match.item.label,
          pathId:      match.pathId,
          pathLabel:   match.pathLabel,
          source:      'path_option_superseded',
        });
        bestClassification = 'not_applied';
        bestReason = `Not applied: ${code} (${match.pathLabel}) satisfies the same "${match.item.label}" requirement already met by the committed path (${committedPath.label}) for ${progTitle}.`;
        bestSource = 'path_option_superseded';
        break;
      }

      // This course's path is the committed one (or no path is complete yet) --> Required.
      evidence.matchedNodes.push({
        programId:   prog.programId,
        matchType:   'path_option',
        label:       match.item.label,
        pathId:      match.pathId,
        pathLabel:   match.pathLabel,
        source:      'path_option_requirement',
      });

      bestClassification = 'required';
      bestReason = `Required: ${code} is a required senior design/capstone course for ${progTitle} (${match.pathLabel}).`;
      bestSource = 'path_option_requirement';
      break;

    } else if (match.type === 'senior_design') {
      // ── Senior design / capstone: always Required ─────────────────────────
      // Capstone is foundational to the degree regardless of how many options exist.
      evidence.matchedNodes.push({
        programId:       prog.programId,
        matchType:       'senior_design',
        label:           match.item.label,
        groupRule:       match.item.groupRule,
        source:          'senior_design_requirement',
      });

      bestClassification = 'required';
      bestReason = `Required: ${code} is a required senior design/capstone course in ${progTitle}.`;
      bestSource = 'senior_design_requirement';
      break;

    } else if (match.type === 'required_choice') {
      // ── Priority 6: Required choice group ────────────────────────────────
      // Two sub-cases:
      //  A. isExact=true  — small explicit list (AERO 430 / MATH 401 / MATH 412)
      //                     --> student's selected option is Required
      //  B. isExact=false — broad/flexible pool (single-code elective, CHEM 120/UCC)
      //                     --> stays Preferred

      const groupCodesLabel = (match.item.codes ?? []).join(' / ');

      if (match.item.isExact) {
        // ── A. Exact required choice group ──────────────────────────────────

        // ── A1. Compound choice (bundles + singles, e.g. CHEM 228+238 vs CHEM 258) ──
        if (match.item.isCompound && (match.item.alternatives?.length ?? 0) >= 2) {
          // Find which alternative this course belongs to
          const myAlt = match.item.alternatives.find((alt) => alt.courses.includes(code));

          // Build the full set of requested codes for this student so we can detect
          // partial-bundle requests and duplicate-alternative selections.
          const allRequestedCodes = new Set(
            context.courseRequests.map((r) => {
              const s = (r.subject ?? '').toUpperCase().trim();
              const n2 = (r.number ?? '').toUpperCase().trim();
              return s && n2 ? `${s} ${n2}` : (r.courseCode ?? '');
            }).filter(Boolean)
          );

          const groupMap  = context.exactChoiceGroupMap ?? {};
          const groupInfo = groupMap[match.item.id];

          if (myAlt?.type === 'bundle') {
            // Student is requesting a course from a bundle alternative.
            // All courses in the bundle are required together.
            const missingBundleCourses = myAlt.courses.filter(
              (c) => c !== code && !allRequestedCodes.has(c)
            );
            const bundleLabel = myAlt.courses.join(' + ');

            evidence.matchedNodes.push({
              programId:                     prog.programId,
              matchType:                     'required_choice',
              label:                         match.item.label,
              codes:                         match.item.codes,
              isExact:                       true,
              isCompound:                    true,
              matchedChoiceGroup:            true,
              choiceGroupType:               'compound_bundle_alternative',
              choiceGroupLabel:              match.item.label,
              choiceGroupOptions:            match.item.codes,
              selectedOption:                code,
              bundleAlternative:             bundleLabel,
              selectedChoicePromotedToRequired: true,
              duplicateChoiceWarning:        false,
              source:                        'exact_required_choice_group',
            });

            if (missingBundleCourses.length > 0) {
              warnings.push(
                `This option also requires ${missingBundleCourses.join(' and ')}.`
              );
            }

            // Check if student is also requesting a different alternative (redundant selection)
            const otherAlts = match.item.alternatives.filter((a) => a !== myAlt);
            for (const other of otherAlts) {
              if (other.courses.some((c) => allRequestedCodes.has(c))) {
                warnings.push(
                  `Multiple alternatives selected for the required choice group "${match.item.label ?? groupCodesLabel}"; only one path is needed.`
                );
                break;
              }
            }

            bestClassification = 'required';
            const titlePart = match.item.label && match.item.label !== code ? ` "${match.item.label}"` : '';
            bestReason = `Required: ${code} is part of the selected required option ${bundleLabel} for the${titlePart} requirement in ${progTitle}.`;
            bestSource = 'exact_required_choice_group';
            break;  // required wins immediately
          } else {
            // Single-course alternative (e.g. CHEM 258).
            // Prefer bundle paths over insertion-order: if any bundle alternative has
            // a course already requested, that bundle path is the selected required path
            // and this single-alternative course is the extra/duplicate.
            const selectedBundleAlt = match.item.alternatives.find(
              (a) => a.type === 'bundle' && a.courses.some((c) => allRequestedCodes.has(c))
            );
            const isDuplicateChoice = selectedBundleAlt != null || (
              groupInfo &&
              groupInfo.allRequestedCodes.length > 1 &&
              groupInfo.firstCode !== code
            );

            if (isDuplicateChoice) {
              evidence.matchedNodes.push({
                programId:                     prog.programId,
                matchType:                     'required_choice',
                label:                         match.item.label,
                codes:                         match.item.codes,
                isExact:                       true,
                isCompound:                    true,
                matchedChoiceGroup:            true,
                choiceGroupType:               'compound_single_alternative',
                choiceGroupLabel:              match.item.label,
                choiceGroupOptions:            match.item.codes,
                selectedOption:                code,
                selectedChoicePromotedToRequired: false,
                duplicateChoiceWarning:        true,
                source:                        'required_choice_group',
              });
              const selectedPathLabel = selectedBundleAlt
                ? selectedBundleAlt.courses.join(' + ')
                : (groupInfo?.firstCode ?? 'another option');
              warnings.push(
                `Multiple alternatives selected for the same required choice group "${match.item.label ?? groupCodesLabel}"; only one path is needed. ${selectedPathLabel} is already selected as the required path.`
              );
              if (!bestClassification || bestClassification === 'not_applied') {
                bestClassification = 'preferred';
                const groupLabel2 = match.item.label && match.item.label !== groupCodesLabel
                  ? `"${match.item.label}"`
                  : groupCodesLabel;
                bestReason = `Preferred: ${code} is an extra alternative for the ${groupLabel2} requirement in ${progTitle}. ${selectedPathLabel} is already the selected required path.`;
                bestSource = 'required_choice_group';
              }
            } else {
              evidence.matchedNodes.push({
                programId:                     prog.programId,
                matchType:                     'required_choice',
                label:                         match.item.label,
                codes:                         match.item.codes,
                isExact:                       true,
                isCompound:                    true,
                matchedChoiceGroup:            true,
                choiceGroupType:               'compound_single_alternative',
                choiceGroupLabel:              match.item.label,
                choiceGroupOptions:            match.item.codes,
                selectedOption:                code,
                selectedChoicePromotedToRequired: true,
                duplicateChoiceWarning:        false,
                source:                        'exact_required_choice_group',
              });
              bestClassification = 'required';
              const titlePart = match.item.label && match.item.label !== code ? ` "${match.item.label}"` : '';
              bestReason = `Required: ${code} is the selected required option for the${titlePart} requirement in ${progTitle}.`;
              bestSource = 'exact_required_choice_group';
              break;  // required wins immediately
            }
          }
        } else {
          // ── A2. Simple exact required choice group (non-compound) ───────────
          const groupMap  = context.exactChoiceGroupMap ?? {};
          const groupInfo = groupMap[match.item.id];
          const isDuplicateChoice = (
            groupInfo &&
            groupInfo.allRequestedCodes.length > 1 &&
            groupInfo.firstCode !== code
          );

          if (isDuplicateChoice) {
            // Multiple options requested from the same required-pick-one group.
            // Only the first is Required; subsequent ones are demoted to Preferred.
            evidence.matchedNodes.push({
              programId:                     prog.programId,
              matchType:                     'required_choice',
              label:                         match.item.label,
              codes:                         match.item.codes,
              isExact:                       true,
              matchedChoiceGroup:            true,
              choiceGroupType:               'exact_required_choice',
              choiceGroupLabel:              match.item.label,
              choiceGroupOptions:            match.item.codes,
              selectedOption:                code,
              selectedChoicePromotedToRequired: false,
              duplicateChoiceWarning:        true,
              source:                        'required_choice_group',
            });
            warnings.push(
              `Multiple courses requested from the same required choice group "${match.item.label ?? groupCodesLabel}"; only one is needed (${groupInfo.firstCode} is classified as required).`
            );
            if (!bestClassification || bestClassification === 'not_applied') {
              bestClassification = 'preferred';
              bestReason = `Preferred: ${code} is an alternative option from a required ${progTitle} choice group (${groupCodesLabel}). Only one course from this group is needed, and ${groupInfo.firstCode} was already selected as the required option.`;
              bestSource = 'required_choice_group';
            }
          } else {
            // Only (or first) requested option from this exact required group --> Required
            evidence.matchedNodes.push({
              programId:                     prog.programId,
              matchType:                     'required_choice',
              label:                         match.item.label,
              codes:                         match.item.codes,
              isExact:                       true,
              matchedChoiceGroup:            true,
              choiceGroupType:               'exact_required_choice',
              choiceGroupLabel:              match.item.label,
              choiceGroupOptions:            match.item.codes,
              selectedOption:                code,
              selectedChoicePromotedToRequired: true,
              duplicateChoiceWarning:        false,
              source:                        'exact_required_choice_group',
            });
            bestClassification = 'required';
            const titlePart = match.item.label && match.item.label !== code && match.item.label !== groupCodesLabel
              ? ` "${match.item.label}"`
              : '';
            bestReason = `Required: ${code} is the selected option from a required ${progTitle} choice group${titlePart}: ${groupCodesLabel}.`;
            bestSource = 'exact_required_choice_group';
            break;  // required wins immediately, same as exact_required
          }
        }  // end if (match.item.isCompound) ... else
      } else {
        // ── B. Broad / flexible pool  ────────────────────────────────────────
        evidence.matchedNodes.push({
          programId:                     prog.programId,
          matchType:                     'required_choice',
          label:                         match.item.label,
          codes:                         match.item.codes,
          isExact:                       false,
          matchedChoiceGroup:            true,
          choiceGroupType:               'broad_flexible_pool',
          choiceGroupLabel:              match.item.label,
          choiceGroupOptions:            match.item.codes,
          selectedOption:                code,
          selectedChoicePromotedToRequired: false,
          duplicateChoiceWarning:        false,
          source:                        'required_choice_group',
        });
        if (!bestClassification || bestClassification === 'not_applied') {
          const groupLabel = match.item.label && match.item.label !== code ? ` (${match.item.label})` : '';
          bestClassification = 'preferred';
          bestReason = `Preferred: ${code} is one option in a required course selection${groupLabel} for ${progTitle}.`;
          bestSource = 'required_choice_group';
        }
      }  // end if (match.item.isExact) ... else

    } else if (match.type === 'pick_n') {
      // ── Priority 7: Pick-N elective pool ─────────────────────────────────
      evidence.matchedNodes.push({
        programId:       prog.programId,
        matchType:       'pick_n',
        label:           match.item.label,
        pickCount:       match.item.pickCount,
        source:          'pick_n_group',
      });

      if (!bestClassification || bestClassification === 'not_applied') {
        const n          = match.item.pickCount ?? 1;
        const groupLabel = match.item.label && match.item.label !== code ? ` "${match.item.label}"` : '';
        bestClassification = 'preferred';
        bestReason = `Preferred: ${code} is an eligible option from a "select ${n}" elective group${groupLabel} in ${progTitle}.`;
        bestSource = 'pick_n_group';
      }
    }
  }

  // ── 9. Student semester plan influence ─────────────────────────────────
  if (!bestClassification && plannedCodes.has(code)) {
    bestClassification = 'preferred';
    bestReason = `${code} appears in the student's semester plan but could not be matched to a specific degree requirement.`;
    bestSource = 'student_plan';
  }

  // ── 10. No match at all --> preferred (may count as elective) ────
  if (!bestClassification) {
    return {
      systemClassification: 'preferred',
      reason:   `Preferred: ${code} does not directly fulfill a required degree component but may apply toward an elective, minor, or other non-required portion of your program.`,
      warnings,
      evidence: { ...evidence, source: 'degree_requirement' },
    };
  }

  return {
    systemClassification: bestClassification,
    reason:               bestReason,
    warnings,
    evidence:             { ...evidence, source: bestSource },
  };
}

// ---------------------------------------------------------------------------
// Phase 11 — Apply classification to a saved CourseRequest document
// ---------------------------------------------------------------------------

async function applyClassificationToCourseRequest(courseRequest, result) {
  const update = {
    systemClassification:  result.systemClassification,
    classificationReason:  result.reason,
    classificationWarnings: result.warnings ?? [],
    classificationEvidence: result.evidence ?? null,
    classifiedAt:          new Date(),
    classifierVersion:     CLASSIFIER_VERSION,
  };

  // Only mirror to finalClassification if no manual override exists
  if ((courseRequest.overrideStatus ?? 'none') !== 'manual_override') {
    update.finalClassification       = result.systemClassification;
    update.finalClassificationReason = null;
  }

  return StudentCourseRequest.findByIdAndUpdate(
    courseRequest._id,
    update,
    { new: true }
  ).lean();
}

// ---------------------------------------------------------------------------
// Exact-choice group pre-computation
// ---------------------------------------------------------------------------

/**
 * For each exact required choice group across all programs, find which
 * (if any) of the student's requested courses fall into that group.
 *
 * Returns a map:  groupId --> { firstCode, allRequestedCodes, groupLabel, programId }
 *   firstCode          — first requested code that appears in this group (by request-array order)
 *   allRequestedCodes  — all requested codes in this group
 *
 * Used by classifyCourseRequest to handle duplicate-choice detection and
 * to promote the first (and only) requested option to 'required'.
 */
function buildExactChoiceGroupMap(courseRequests, programEvidence) {
  const map = {};

  // Build ordered list of normalized codes from all course requests
  const requestedCodes = courseRequests.map((r) => normalizeCode(r.subject, r.number));

  for (const [programId, ev] of Object.entries(programEvidence)) {
    if (!ev?.hasData) continue;
    for (const grp of ev.requiredChoiceGroups ?? []) {
      if (!grp.isExact) continue;
      // Preserve request-array order so "first" is deterministic
      const inGroup = requestedCodes.filter((c) => grp.codes.includes(c));
      if (inGroup.length === 0) continue;
      // A group can technically appear in multiple programs (e.g. cross-listed);
      // store the first program that finds it.
      if (!map[grp.id]) {
        map[grp.id] = {
          firstCode:         inGroup[0],
          allRequestedCodes: inGroup,
          groupLabel:        grp.label,
          groupCodes:        grp.codes,
          programId,
        };
      }
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// Phase 12 — Classify all requests for a student/cycle
// ---------------------------------------------------------------------------

async function classifyStudentCourseRequests({ userId, cohortId, schedulingCycleId }) {
  const context = await buildClassificationContext({ userId, cohortId, schedulingCycleId });
  const { graphWarnings } = context;

  // Pre-compute exact-choice group membership so duplicate-choice detection
  // works across all requests without requiring a second pass.
  context.exactChoiceGroupMap = buildExactChoiceGroupMap(
    context.courseRequests,
    context.programEvidence,
  );

  const requests = await StudentCourseRequest.find({
    userId,
    cohortId,
    ...(schedulingCycleId ? { schedulingCycleId } : {}),
  }).lean();

  const results = [];
  for (const req of requests) {
    let result;
    try {
      result = await classifyCourseRequest(req, context);
    } catch (err) {
      result = {
        systemClassification: 'unclassified',
        reason: `Classification error: ${err.message}`,
        warnings: [],
        evidence: { source: 'missing_data' },
      };
    }
    const updated = await applyClassificationToCourseRequest(req, result);
    results.push(updated);
  }

  return { results, runWarnings: graphWarnings ?? [] };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  classifyCourseRequest,
  classifyStudentCourseRequests,
  buildClassificationContext,
  buildExactChoiceGroupMap,
  applyClassificationToCourseRequest,
  classifyCourseAgainstProgram,
  evaluateOfferingAvailability,
  evaluatePrerequisiteEligibility,
  evaluateFlexibleRequirementMatch,
  CLASSIFIER_VERSION,
};
