'use strict';
/**
 * Static degree-plan data loader.
 *
 * Loads server/data/degree-plans.json once into memory.
 * Adapted from reference/tamu-course-offering-history/lib/degree-planner-data.mjs.
 * Live catalog scraper is intentionally excluded.
 */

const path = require('path');
const fs = require('fs');

const DEGREE_PLANS_PATH = path.join(__dirname, '../../data/degree-plans.json');

/** @type {{plans: Array}|null} */
let cache = null;

function loadPayload() {
  if (cache) return cache;
  const raw = fs.readFileSync(DEGREE_PLANS_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  cache = { plans: Array.isArray(parsed?.plans) ? parsed.plans : [] };
  return cache;
}

/**
 * List all available degree plans (id, title, catalog).
 * @returns {{plans: Array<{id:string, title:string, catalog:string}>}}
 */
function listDegreePlans() {
  const { plans } = loadPayload();
  return {
    plans: plans.map((p) => ({
      id: p.id,
      title: p.title,
      catalog: p.catalog ?? null,
    })),
  };
}

/**
 * Get the full plan object by id.
 * Throws with statusCode 404 if not found.
 * @param {string} planId
 * @returns {object}
 */
function getDegreePlan(planId) {
  const { plans } = loadPayload();
  const plan = plans.find((p) => p.id === planId);
  if (!plan) {
    const err = new Error(`Unknown degree plan: ${planId}`);
    err.statusCode = 404;
    throw err;
  }
  // Return a deep clone so callers can't mutate the cache
  return JSON.parse(JSON.stringify(plan));
}

module.exports = { listDegreePlans, getDegreePlan };
