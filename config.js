'use strict';

/**
 * config.js — single source of truth for every tunable in the system.
 *
 * Design note: parsing happens at require-time, but *validation* is an explicit
 * `validate()` call rather than a throw-on-import. That keeps the module safely
 * importable by tests and by a future dashboard (neither of which needs an API
 * key) while index.js still fails fast at boot — which is the moment that
 * actually matters for an unattended service.
 */

require('dotenv').config();

const path = require('path');
const cron = require('node-cron');

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Comma-separated env var -> trimmed, non-empty array. */
function parseList(value, fallback = []) {
  if (!value || !String(value).trim()) return fallback;
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

/** Integer env var with a floor, so a typo like MAX_RETRIES=0 cannot wedge the app. */
function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

// ---------------------------------------------------------------------------
// Search targets
// ---------------------------------------------------------------------------

const DEFAULT_CATEGORIES = ['מסעדות', 'בתי קפה', 'מספרות', 'מוסכים', 'עורכי דין', 'מרפאות שיניים'];
const DEFAULT_LOCATIONS = ['תל אביב', 'ירושלים', 'חיפה', 'רמת גן', 'הרצליה'];

const CATEGORIES = parseList(process.env.CATEGORIES, DEFAULT_CATEGORIES);
const LOCATIONS = parseList(process.env.LOCATIONS, DEFAULT_LOCATIONS);
const QUERY_TEMPLATE = process.env.QUERY_TEMPLATE || '{category} {location}';
const EXPLICIT_QUERIES = parseList(process.env.QUERIES);

/**
 * Build the work list: the cartesian product of categories x locations.
 *
 * Each entry keeps `category` and `location` alongside the query text so the
 * CSV can record which search produced a lead — useful for a dashboard that
 * wants to filter by city, and for spotting a query that returns nothing.
 */
function buildQueries() {
  if (EXPLICIT_QUERIES.length > 0) {
    return EXPLICIT_QUERIES.map((text) => ({ text, category: '', location: '' }));
  }
  const queries = [];
  for (const category of CATEGORIES) {
    for (const location of LOCATIONS) {
      queries.push({
        text: QUERY_TEMPLATE.replace('{category}', category).replace('{location}', location),
        category,
        location,
      });
    }
  }
  return queries;
}

const QUERIES = buildQueries();

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, 'data');

const config = {
  // --- Google ---
  GOOGLE_MAPS_API_KEY: (process.env.GOOGLE_MAPS_API_KEY || '').trim(),
  PLACES_SEARCH_URL: 'https://places.googleapis.com/v1/places:searchText',
  LANGUAGE_CODE: process.env.LANGUAGE_CODE || 'he',
  REGION_CODE: process.env.REGION_CODE || 'IL',

  // --- What to search ---
  CATEGORIES,
  LOCATIONS,
  QUERY_TEMPLATE,
  QUERIES,

  // --- Schedule ---
  CRON_SCHEDULE: process.env.CRON_SCHEDULE || '0 2 * * 0',
  CRON_TIMEZONE: process.env.CRON_TIMEZONE || 'Asia/Jerusalem',
  RUN_ON_START: parseBool(process.env.RUN_ON_START, true),

  // --- Budget guard ---
  // Google grants 1,000 free Enterprise-SKU calls/month; default 950 keeps a margin.
  MONTHLY_CALL_BUDGET: parseInteger(process.env.MONTHLY_CALL_BUDGET, 950, { min: 1 }),
  // Google serves at most ~3 pages (60 results) per text query.
  MAX_PAGES_PER_QUERY: parseInteger(process.env.MAX_PAGES_PER_QUERY, 3, { min: 1, max: 3 }),

  // --- Data quality ---
  REQUIRE_PHONE: parseBool(process.env.REQUIRE_PHONE, true),
  WRITE_JSON_MIRROR: parseBool(process.env.WRITE_JSON_MIRROR, true),

  // --- Network / resilience ---
  REQUEST_TIMEOUT_MS: parseInteger(process.env.REQUEST_TIMEOUT_MS, 15000, { min: 1000 }),
  MAX_RETRIES: parseInteger(process.env.MAX_RETRIES, 4, { min: 0, max: 10 }),
  RETRY_BASE_DELAY_MS: parseInteger(process.env.RETRY_BASE_DELAY_MS, 1000, { min: 100 }),
  DELAY_BETWEEN_REQUESTS_MS: parseInteger(process.env.DELAY_BETWEEN_REQUESTS_MS, 250, { min: 0 }),

  // --- Storage ---
  DATA_DIR,
  LEADS_CSV: path.join(DATA_DIR, 'leads.csv'),
  LEADS_JSON: path.join(DATA_DIR, 'leads.json'),
  USAGE_FILE: path.join(DATA_DIR, 'usage.json'),

  LOG_LEVEL: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Collect every problem before reporting, so a misconfigured .env surfaces all
 * of its issues in one pass instead of one restart per mistake.
 * @returns {string[]} human-readable problems; empty means good to go.
 */
function collectProblems() {
  const problems = [];

  if (!config.GOOGLE_MAPS_API_KEY) {
    problems.push(
      'GOOGLE_MAPS_API_KEY is missing. Copy .env.example to .env and paste a key from ' +
        'Google Cloud Console (with "Places API (New)" enabled).'
    );
  }

  if (!cron.validate(config.CRON_SCHEDULE)) {
    problems.push(
      `CRON_SCHEDULE "${config.CRON_SCHEDULE}" is not a valid 5-field cron expression. ` +
        'Example: "0 2 * * 0" = every Sunday at 02:00.'
    );
  }

  // An invalid IANA zone makes node-cron fire at the wrong hour rather than
  // erroring, so check it up front with the platform's own tz database.
  try {
    Intl.DateTimeFormat(undefined, { timeZone: config.CRON_TIMEZONE });
  } catch {
    problems.push(
      `CRON_TIMEZONE "${config.CRON_TIMEZONE}" is not a valid IANA timezone. Example: "Asia/Jerusalem".`
    );
  }

  if (config.QUERIES.length === 0) {
    problems.push(
      'No search queries. Set CATEGORIES and LOCATIONS (or QUERIES) in .env — otherwise there is nothing to harvest.'
    );
  }

  if (!config.QUERY_TEMPLATE.includes('{category}') && EXPLICIT_QUERIES.length === 0) {
    problems.push('QUERY_TEMPLATE must contain "{category}" (and normally "{location}").');
  }

  return problems;
}

/** Throw a single readable error listing everything that is wrong. */
function validate() {
  const problems = collectProblems();
  if (problems.length > 0) {
    const error = new Error(
      `Configuration is invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}`
    );
    error.name = 'ConfigError';
    throw error;
  }
  return config;
}

// Export the config object ITSELF, not a spread copy. A copy would give
// collectProblems()/validate() a different object than the one callers hold,
// so an override applied by a caller (or a test) would silently not be seen by
// validation. One object, one source of truth.
config.validate = validate;
config.collectProblems = collectProblems;

module.exports = config;
