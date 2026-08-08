'use strict';

/**
 * Join Code utilities
 *
 * 6-character alphanumeric codes (uppercase A-Z, digits 2-9).
 * Ambiguous characters O, I, 0, 1 are excluded to avoid confusion.
 */

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // excludes O, I, 0, 1
const CODE_LENGTH = 6;
const MAX_ATTEMPTS = 20;

// Preset durations a join code can stay active. 'never' = no expiry (null).
const DAY_MS = 24 * 60 * 60 * 1000;
const JOIN_CODE_DURATION_MS = {
  '1d':  1  * DAY_MS,
  '3d':  3  * DAY_MS,
  '7d':  7  * DAY_MS,
  '30d': 30 * DAY_MS,
  'never': null,
};
const DEFAULT_JOIN_CODE_DURATION = '3d';

// Coerce any input to a valid preset key, falling back to the default.
function normalizeJoinCodeDuration(duration) {
  return Object.prototype.hasOwnProperty.call(JOIN_CODE_DURATION_MS, duration)
    ? duration
    : DEFAULT_JOIN_CODE_DURATION;
}

// Expiry Date for a duration key, or null for 'never'.
function resolveJoinCodeExpiry(duration, from = new Date()) {
  const ms = JOIN_CODE_DURATION_MS[normalizeJoinCodeDuration(duration)];
  return ms == null ? null : new Date(from.getTime() + ms);
}

/**
 * Normalize a join code: uppercase and strip non-alphanumeric characters.
 */
function normalizeJoinCode(code) {
  return String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Validate that a join code is exactly 6 alphanumeric uppercase characters.
 */
function validateJoinCodeFormat(code) {
  return /^[A-Z0-9]{6}$/.test(code);
}

/**
 * Generate a random 6-character join code from the charset.
 */
function generateJoinCode(length = CODE_LENGTH) {
  const chars = [];
  for (let i = 0; i < length; i++) {
    chars.push(CHARSET[Math.floor(Math.random() * CHARSET.length)]);
  }
  return chars.join('');
}

/**
 * Generate a unique join code not already used by any cohort.
 * @returns {Promise<string>} unique 6-char uppercase code
 */
async function generateUniqueJoinCode() {
  const Cohort = require('../models/Cohort');
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generateJoinCode();
    const existing = await Cohort.findOne({ joinCode: code }).lean();
    if (!existing) return code;
  }
  throw new Error('Failed to generate a unique join code after multiple attempts. Try again.');
}

module.exports = {
  normalizeJoinCode,
  validateJoinCodeFormat,
  generateJoinCode,
  generateUniqueJoinCode,
  normalizeJoinCodeDuration,
  resolveJoinCodeExpiry,
  DEFAULT_JOIN_CODE_DURATION,
};
