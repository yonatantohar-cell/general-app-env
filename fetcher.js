'use strict';

/**
 * fetcher.js — Google Places API (New) client.
 *
 * Endpoint: POST https://places.googleapis.com/v1/places:searchText
 *
 * Three things here are non-obvious and worth reading before editing:
 *
 * 1. This targets Places API (NEW), not the legacy `maps.googleapis.com/maps/api/place/*`
 *    endpoints. Google moved the legacy API to Legacy status and new Cloud
 *    projects can no longer enable it, so legacy examples (textsearch/json,
 *    next_page_token) simply will not work with a freshly minted key.
 *
 * 2. `nextPageToken` MUST appear in the field mask. The New API returns only
 *    what the mask names, and the token is a TOP-LEVEL field (not `places.*`).
 *    Leave it out and pagination silently returns page 1 forever — no error.
 *
 * 3. Phone numbers put the request in the Enterprise SKU. That is why we ask
 *    for phones in the SEARCH itself rather than doing a per-place Details
 *    lookup: one billed call returns up to 20 complete leads instead of one.
 *    Since Enterprise is already the top tier, websiteUri / rating /
 *    userRatingCount ride along at no extra cost.
 */

const axios = require('axios');

const config = require('./config');
const logger = require('./logger');
const usage = require('./usage');

// `nextPageToken` first — see note 3 above. Everything else is `places.`-prefixed.
const FIELD_MASK = [
  'nextPageToken',
  'places.id',
  'places.displayName',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.primaryType',
  'places.primaryTypeDisplayName',
  'places.types',
  'places.formattedAddress',
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
].join(',');

const client = axios.create({
  timeout: config.REQUEST_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/json',
    'X-Goog-Api-Key': config.GOOGLE_MAPS_API_KEY,
    'X-Goog-FieldMask': FIELD_MASK,
  },
  // Never throw on status; we classify responses ourselves below.
  validateStatus: () => true,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * 429 = rate limited, 5xx = Google's problem: both worth retrying.
 * 4xx (other) = OUR problem — a bad key, a disabled API, a malformed body.
 * Retrying those just burns quota and delays the operator seeing the real
 * message, so they fail immediately with an actionable hint instead.
 */
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function isRetryableNetworkError(err) {
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(err.code);
}

/** Turn Google's error envelope into a message an operator can act on. */
function describeApiError(status, body) {
  const apiMessage = body && body.error && body.error.message ? body.error.message : 'no message returned';
  const hints = {
    400: 'Bad request — usually a malformed field mask or an empty textQuery.',
    401: 'Unauthorized — the API key is missing or invalid.',
    403: 'Forbidden — enable "Places API (New)" in Google Cloud Console, confirm a billing account is attached (required even on the free tier), and check the key\'s API/referrer restrictions.',
    404: 'Not found — check the endpoint URL.',
  };
  const hint = hints[status] ? ` ${hints[status]}` : '';
  const error = new Error(`Places API returned HTTP ${status}: ${apiMessage}.${hint}`);
  error.name = 'PlacesApiError';
  error.status = status;
  error.details = body && body.error ? body.error : undefined;
  return error;
}

/** Respect Retry-After when Google sends it (seconds, or an HTTP date). */
function retryAfterMs(headers) {
  const header = headers && (headers['retry-after'] || headers['Retry-After']);
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

// ---------------------------------------------------------------------------
// HTTP with retries
// ---------------------------------------------------------------------------

/**
 * POST one page of results, retrying transient failures with exponential
 * backoff + jitter. Jitter matters: without it, a burst of queries that all hit
 * the same rate limit would retry in lockstep and hit it again together.
 */
async function requestPage(body, attempt = 0) {
  // Reserve quota *before* the call — a failed call still consumed it upstream.
  usage.reserveCall();

  let response;
  try {
    response = await client.post(config.PLACES_SEARCH_URL, body);
  } catch (err) {
    if (isRetryableNetworkError(err) && attempt < config.MAX_RETRIES) {
      const delay = config.RETRY_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 250);
      logger.warn(
        `Network error (${err.code}) on attempt ${attempt + 1}/${config.MAX_RETRIES + 1}; retrying in ${delay}ms`
      );
      await sleep(delay);
      return requestPage(body, attempt + 1);
    }
    const wrapped = new Error(`Network failure calling Places API: ${err.message}`);
    wrapped.name = 'NetworkError';
    wrapped.code = err.code;
    throw wrapped;
  }

  const { status, data, headers } = response;

  if (status === 200) return data;

  if (isRetryableStatus(status) && attempt < config.MAX_RETRIES) {
    const suggested = retryAfterMs(headers);
    const backoff = config.RETRY_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 250);
    const delay = suggested !== null ? Math.max(suggested, backoff) : backoff;

    logger.warn(
      `HTTP ${status} from Places API on attempt ${attempt + 1}/${config.MAX_RETRIES + 1}; retrying in ${delay}ms` +
        (status === 429 ? ' (rate limited)' : '')
    );
    await sleep(delay);
    return requestPage(body, attempt + 1);
  }

  throw describeApiError(status, data);
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** "hair_care" -> "Hair Care" */
function prettifyType(type) {
  if (!type) return '';
  return String(type)
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Map a raw Places result to a flat lead row.
 *
 * Gotcha: `displayName` and `primaryTypeDisplayName` are OBJECTS
 * ({ text, languageCode }), not strings. Treating them as strings writes
 * "[object Object]" into every row — silently, since nothing throws.
 */
function normalizePlace(place, query = {}) {
  if (!place || !place.id) return null;

  const name = (place.displayName && place.displayName.text) || '';
  const phone = (place.nationalPhoneNumber || place.internationalPhoneNumber || '').trim();

  // Prefer Google's localized, human-readable label; fall back to raw types.
  const category =
    (place.primaryTypeDisplayName && place.primaryTypeDisplayName.text) ||
    prettifyType(place.primaryType) ||
    prettifyType(Array.isArray(place.types) ? place.types[0] : '') ||
    '';

  return {
    name,
    phone,
    category,
    place_id: place.id,
    address: place.formattedAddress || '',
    website: place.websiteUri || '',
    rating: place.rating === undefined || place.rating === null ? '' : String(place.rating),
    user_ratings: place.userRatingCount === undefined || place.userRatingCount === null ? '' : String(place.userRatingCount),
    business_status: place.businessStatus || '',
    search_query: query.text || '',
    search_category: query.category || '',
    search_location: query.location || '',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run one text query to exhaustion, following nextPageToken.
 * @returns {Promise<{leads: object[], pages: number, rawCount: number, droppedNoPhone: number}>}
 */
async function searchQuery(query) {
  const leads = [];
  let pageToken;
  let pages = 0;
  let rawCount = 0;
  let droppedNoPhone = 0;

  do {
    const body = {
      textQuery: query.text,
      pageSize: 20, // API maximum
      languageCode: config.LANGUAGE_CODE,
      regionCode: config.REGION_CODE,
    };
    if (pageToken) body.pageToken = pageToken;

    const data = await requestPage(body);
    pages += 1;

    const places = Array.isArray(data.places) ? data.places : [];
    rawCount += places.length;

    for (const place of places) {
      const lead = normalizePlace(place, query);
      if (!lead) continue;
      if (config.REQUIRE_PHONE && !lead.phone) {
        droppedNoPhone += 1;
        continue;
      }
      leads.push(lead);
    }

    pageToken = data.nextPageToken;

    // Be a polite client: brief pause between pages keeps us under the QPS ceiling.
    if (pageToken && pages < config.MAX_PAGES_PER_QUERY && config.DELAY_BETWEEN_REQUESTS_MS > 0) {
      await sleep(config.DELAY_BETWEEN_REQUESTS_MS);
    }
  } while (pageToken && pages < config.MAX_PAGES_PER_QUERY);

  logger.debug(
    `Query "${query.text}": ${pages} page(s), ${rawCount} raw result(s), ${leads.length} lead(s)` +
      (droppedNoPhone ? `, ${droppedNoPhone} dropped (no phone)` : '')
  );

  return { leads, pages, rawCount, droppedNoPhone };
}

module.exports = {
  searchQuery,
  normalizePlace,
  prettifyType,
  requestPage,
  isRetryableStatus,
  retryAfterMs,
  FIELD_MASK,
  __client: client, // exposed for offline tests to stub
};
