'use strict';
/**
 * degreeGraphBuilder.js
 *
 * Builds or retrieves a DegreeRequirementGraph for a given programId, checking
 * in-memory cache -> MongoDB -> a static JSON snapshot -> a live catalog
 * scrape, in that order.
 *
 * The live-scrape tier (catalog.tamu.edu HTML parsing) is removed in this
 * public repo — see README for why. The cache/DB/static-file tiers below are
 * unchanged and still fully functional.
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
/** @type {Map<string, object>} programId --> graph */
const memCache = new Map();
/** @type {Map<string, number>} programId --> timestamp (ms) */
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
// Catalog HTML parsing helpers removed for the public repo — see README.
function extractCourseCodes() {
  return [];
}

function parseCourseListAreas() {
  return [];
}

function parsePrerequisiteEdges() {
  return [];
}

function parseCorequisiteEdges() {
  return [];
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
// Live catalog.tamu.edu scraper removed for the public repo — see README.
async function fetchHtml() {
  throw new Error('Catalog scraping is not included in this public version — see README.');
}

async function scrapeGraphFromCatalog(programId) {
  return {
    programId, catalog: null, title: programId, sourceUrl: null,
    nodes: [], edges: [], flexibleRequirements: [],
    warnings: ['Live catalog scraping is not included in this public version.'],
    source: 'static',
  };
}

function parseCourseCatalogPage() {
  return {};
}

const PARSER_VERSION = 43; // v43: alias retired courses (MATH 253 --> MATH 251)

/**
 * Get (or build) the degree requirement graph for a programId.
 * Uses in-memory cache --> MongoDB cache --> static file --> scraper.
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
 * Order: static plans --> degreePlanId lookup --> pre-built generated JSON --> live catalog scrape.
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
