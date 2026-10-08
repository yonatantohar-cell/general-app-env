'use strict';

/**
 * offline.test.js — proves the whole pipeline without touching Google.
 *
 *   npm test
 *
 * Every network call is stubbed, so this verifies the parts that are easy to
 * get silently wrong (pagination tokens, retry policy, dedupe, encoding)
 * without an API key and without spending quota.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.LOG_LEVEL = 'error'; // keep test output readable

const config = require('../config');

// Redirect all state into a throwaway directory BEFORE anything writes.
// config's exports are a live object, and every module reads these paths at
// call time, so mutating here reroutes the whole system.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'leadgen-test-'));
config.DATA_DIR = TMP;
config.LEADS_CSV = path.join(TMP, 'leads.csv');
config.LEADS_JSON = path.join(TMP, 'leads.json');
config.USAGE_FILE = path.join(TMP, 'usage.json');
config.RETRY_BASE_DELAY_MS = 10;
config.DELAY_BETWEEN_REQUESTS_MS = 0;
config.MAX_RETRIES = 3;
config.MONTHLY_CALL_BUDGET = 1000;

const fetcher = require('../fetcher');
const database = require('../database');
const usage = require('../usage');

// --------------------------------------------------------------------------
// Tiny test harness
// --------------------------------------------------------------------------

const results = [];
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    results.push(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    results.push(`  ✗ ${name}\n      ${err.message}`);
  }
}

/** Replace fetcher's axios instance .post with a scripted queue of responses. */
function stubResponses(responses) {
  const calls = [];
  fetcher.__client.post = async (url, body) => {
    calls.push({ url, body });
    const next = responses.shift();
    if (!next) throw new Error('stub ran out of responses');
    if (next.throw) throw next.throw;
    return { status: next.status, data: next.data, headers: next.headers || {} };
  };
  return calls;
}

function resetState() {
  for (const file of [config.LEADS_CSV, config.LEADS_JSON, config.USAGE_FILE]) {
    try { fs.unlinkSync(file); } catch { /* not there — fine */ }
  }
}

/** Build a fake Places API result, shaped exactly like the real one. */
function fakePlace(n, overrides = {}) {
  return {
    id: `PLACE_${n}`,
    displayName: { text: `עסק מספר ${n}`, languageCode: 'he' },
    nationalPhoneNumber: `03-555-${String(1000 + n).padStart(4, '0')}`,
    primaryType: 'restaurant',
    primaryTypeDisplayName: { text: 'מסעדה', languageCode: 'he' },
    types: ['restaurant', 'food'],
    formattedAddress: `רחוב הדוגמה ${n}, תל אביב`,
    websiteUri: `https://example.com/${n}`,
    rating: 4.2,
    userRatingCount: 100 + n,
    businessStatus: 'OPERATIONAL',
    ...overrides,
  };
}

const QUERY = { text: 'מסעדות תל אביב', category: 'מסעדות', location: 'תל אביב' };

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

async function run() {
  // ---- Field mask ------------------------------------------------------
  await test('field mask requests nextPageToken (else pagination silently dies)', () => {
    assert.ok(
      fetcher.FIELD_MASK.split(',').includes('nextPageToken'),
      'nextPageToken missing from field mask'
    );
    assert.ok(fetcher.FIELD_MASK.includes('places.nationalPhoneNumber'));
    assert.ok(fetcher.FIELD_MASK.includes('places.displayName'));
  });

  // ---- Normalization ---------------------------------------------------
  await test('normalizePlace unwraps displayName/primaryTypeDisplayName objects', () => {
    const lead = fetcher.normalizePlace(fakePlace(1), QUERY);
    assert.strictEqual(lead.name, 'עסק מספר 1');
    assert.strictEqual(lead.category, 'מסעדה');
    assert.strictEqual(lead.phone, '03-555-1001');
    assert.strictEqual(lead.place_id, 'PLACE_1');
    assert.strictEqual(lead.search_location, 'תל אביב');
    assert.ok(!JSON.stringify(lead).includes('[object Object]'), 'object leaked into a field');
  });

  await test('category falls back to primaryType when no display name is present', () => {
    const lead = fetcher.normalizePlace(
      fakePlace(2, { primaryTypeDisplayName: undefined, primaryType: 'hair_care' }),
      QUERY
    );
    assert.strictEqual(lead.category, 'Hair Care');
  });

  // ---- Pagination ------------------------------------------------------
  await test('pagination follows nextPageToken and sends it on the next request', async () => {
    resetState();
    const calls = stubResponses([
      { status: 200, data: { places: [fakePlace(1), fakePlace(2)], nextPageToken: 'TOKEN_A' } },
      { status: 200, data: { places: [fakePlace(3)], nextPageToken: 'TOKEN_B' } },
      { status: 200, data: { places: [fakePlace(4)] } }, // no token -> stop
    ]);

    const result = await fetcher.searchQuery(QUERY);

    assert.strictEqual(result.pages, 3, 'should have fetched 3 pages');
    assert.strictEqual(result.leads.length, 4);
    assert.strictEqual(calls[0].body.pageToken, undefined, 'first call must not send a token');
    assert.strictEqual(calls[1].body.pageToken, 'TOKEN_A');
    assert.strictEqual(calls[2].body.pageToken, 'TOKEN_B');
    assert.strictEqual(calls[0].body.pageSize, 20);
    assert.strictEqual(calls[0].body.languageCode, config.LANGUAGE_CODE);
  });

  await test('pagination stops at MAX_PAGES_PER_QUERY even if Google keeps offering tokens', async () => {
    resetState();
    const original = config.MAX_PAGES_PER_QUERY;
    config.MAX_PAGES_PER_QUERY = 2;
    stubResponses([
      { status: 200, data: { places: [fakePlace(1)], nextPageToken: 'T1' } },
      { status: 200, data: { places: [fakePlace(2)], nextPageToken: 'T2' } },
      { status: 200, data: { places: [fakePlace(3)], nextPageToken: 'T3' } },
    ]);
    const result = await fetcher.searchQuery(QUERY);
    assert.strictEqual(result.pages, 2);
    config.MAX_PAGES_PER_QUERY = original;
  });

  // ---- Retry policy ----------------------------------------------------
  await test('retries HTTP 429 and honours Retry-After', async () => {
    resetState();
    const startedAt = Date.now();
    stubResponses([
      { status: 429, data: { error: { message: 'rate limited' } }, headers: { 'retry-after': '0.05' } },
      { status: 200, data: { places: [fakePlace(1)] } },
    ]);

    const result = await fetcher.searchQuery(QUERY);
    assert.strictEqual(result.leads.length, 1, 'should succeed after the retry');
    assert.ok(Date.now() - startedAt >= 45, 'should have waited for Retry-After');
  });

  await test('retries 5xx', async () => {
    resetState();
    stubResponses([
      { status: 503, data: { error: { message: 'unavailable' } } },
      { status: 200, data: { places: [fakePlace(1)] } },
    ]);
    const result = await fetcher.searchQuery(QUERY);
    assert.strictEqual(result.leads.length, 1);
  });

  await test('does NOT retry 403, and explains how to fix it', async () => {
    resetState();
    const calls = stubResponses([
      { status: 403, data: { error: { message: 'PERMISSION_DENIED', status: 'PERMISSION_DENIED' } } },
      { status: 200, data: { places: [fakePlace(1)] } }, // must never be reached
    ]);

    await assert.rejects(
      () => fetcher.searchQuery(QUERY),
      (err) => {
        assert.strictEqual(err.name, 'PlacesApiError');
        assert.strictEqual(err.status, 403);
        assert.ok(/Places API \(New\)/.test(err.message), 'error should name the fix');
        return true;
      }
    );
    assert.strictEqual(calls.length, 1, 'a 403 must not be retried — it would just burn quota');
  });

  await test('retries transient network errors', async () => {
    resetState();
    const boom = new Error('socket hang up');
    boom.code = 'ECONNRESET';
    stubResponses([{ throw: boom }, { status: 200, data: { places: [fakePlace(1)] } }]);
    const result = await fetcher.searchQuery(QUERY);
    assert.strictEqual(result.leads.length, 1);
  });

  // ---- Data quality ----------------------------------------------------
  await test('drops results with no phone number when REQUIRE_PHONE is on', async () => {
    resetState();
    stubResponses([
      {
        status: 200,
        data: {
          places: [
            fakePlace(1),
            fakePlace(2, { nationalPhoneNumber: undefined, internationalPhoneNumber: undefined }),
          ],
        },
      },
    ]);
    const result = await fetcher.searchQuery(QUERY);
    assert.strictEqual(result.leads.length, 1);
    assert.strictEqual(result.droppedNoPhone, 1);
  });

  // ---- Budget guard ----------------------------------------------------
  await test('budget guard stops the run when the monthly free tier is spent', async () => {
    resetState();
    const original = config.MONTHLY_CALL_BUDGET;
    config.MONTHLY_CALL_BUDGET = 2;
    stubResponses([
      { status: 200, data: { places: [fakePlace(1)], nextPageToken: 'T1' } },
      { status: 200, data: { places: [fakePlace(2)], nextPageToken: 'T2' } },
      { status: 200, data: { places: [fakePlace(3)] } },
    ]);

    await assert.rejects(
      () => fetcher.searchQuery(QUERY),
      (err) => err instanceof usage.BudgetExhaustedError
    );
    assert.strictEqual(usage.summary().used, 2, 'must not exceed the cap');
    config.MONTHLY_CALL_BUDGET = original;
  });

  await test('quota counter survives a restart (persisted to disk)', () => {
    resetState();
    usage.reserveCall();
    usage.reserveCall();
    assert.strictEqual(usage.getUsedCalls(), 2);
    assert.ok(fs.existsSync(config.USAGE_FILE), 'usage.json should exist on disk');
    assert.strictEqual(JSON.parse(fs.readFileSync(config.USAGE_FILE, 'utf8')).calls, 2);
  });

  // ---- Dedupe / storage -------------------------------------------------
  await test('re-running the same harvest inserts nothing the second time', () => {
    resetState();
    const batch = [1, 2, 3].map((n) => fetcher.normalizePlace(fakePlace(n), QUERY));

    const first = database.upsertLeads(batch);
    assert.deepStrictEqual(
      { inserted: first.inserted, updated: first.updated, total: first.total },
      { inserted: 3, updated: 0, total: 3 }
    );

    const second = database.upsertLeads(batch);
    assert.deepStrictEqual(
      { inserted: second.inserted, updated: second.updated, total: second.total },
      { inserted: 0, updated: 3, total: 3 },
      'a repeat run must refresh, never duplicate'
    );
  });

  await test('refresh keeps first_seen_at and advances last_seen_at', async () => {
    resetState();
    const batch = [fetcher.normalizePlace(fakePlace(1), QUERY)];
    database.upsertLeads(batch);
    const before = database.readLeads()[0];

    await new Promise((resolve) => setTimeout(resolve, 5));
    database.upsertLeads([{ ...batch[0], phone: '03-999-9999', rating: '4.9' }]);
    const after = database.readLeads()[0];

    assert.strictEqual(after.first_seen_at, before.first_seen_at, 'first_seen_at is history; do not rewrite it');
    assert.ok(after.last_seen_at > before.last_seen_at, 'last_seen_at should advance');
    assert.strictEqual(after.phone, '03-999-9999', 'changed phone should be refreshed');
    assert.strictEqual(after.rating, '4.9');
  });

  await test('a blank field in a later response never erases a known value', () => {
    resetState();
    database.upsertLeads([fetcher.normalizePlace(fakePlace(1), QUERY)]);
    database.upsertLeads([{ ...fetcher.normalizePlace(fakePlace(1), QUERY), website: '' }]);
    assert.strictEqual(database.readLeads()[0].website, 'https://example.com/1');
  });

  await test('same business under two place_ids is deduped by phone', () => {
    resetState();
    const a = fetcher.normalizePlace(fakePlace(1), QUERY);
    const b = { ...a, place_id: 'DIFFERENT_ID', phone: '+972 3-555-1001' };
    database.upsertLeads([a]);
    const result = database.upsertLeads([b]);
    assert.strictEqual(result.inserted, 0, 'international format of the same number is not a new lead');
    assert.strictEqual(result.total, 1);
  });

  await test('overlapping queries in one batch do not double-insert', () => {
    resetState();
    const fromTelAviv = fetcher.normalizePlace(fakePlace(7), QUERY);
    const fromRamatGan = fetcher.normalizePlace(fakePlace(7), {
      text: 'מסעדות רמת גן', category: 'מסעדות', location: 'רמת גן',
    });
    const result = database.upsertLeads([fromTelAviv, fromRamatGan]);
    assert.strictEqual(result.inserted, 1);
    assert.strictEqual(result.total, 1);
  });

  // ---- Encoding / file format -------------------------------------------
  await test('CSV starts with a UTF-8 BOM so Excel renders Hebrew correctly', () => {
    resetState();
    database.upsertLeads([fetcher.normalizePlace(fakePlace(1), QUERY)]);
    const raw = fs.readFileSync(config.LEADS_CSV, 'utf8');
    assert.strictEqual(raw.charCodeAt(0), 0xfeff, 'missing BOM — Excel would show mojibake');
    assert.ok(raw.includes('עסק מספר 1'), 'Hebrew should be stored as-is');
  });

  await test('written CSV parses back cleanly, BOM and all', () => {
    resetState();
    const batch = [1, 2].map((n) => fetcher.normalizePlace(fakePlace(n), QUERY));
    database.upsertLeads(batch);
    const rows = database.readLeads();
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].name, 'עסק מספר 1', 'BOM must not bleed into the first column');
    assert.strictEqual(rows[0].category, 'מסעדה');
  });

  await test('commas inside addresses stay quoted and do not shift columns', () => {
    resetState();
    const lead = fetcher.normalizePlace(
      fakePlace(1, { formattedAddress: 'הדולפין 1, יפו, תל אביב' }),
      QUERY
    );
    database.upsertLeads([lead]);
    const row = database.readLeads()[0];
    assert.strictEqual(row.address, 'הדולפין 1, יפו, תל אביב');
    assert.strictEqual(row.place_id, 'PLACE_1', 'columns must not have shifted');
  });

  await test('JSON mirror is written for a future dashboard', () => {
    resetState();
    database.upsertLeads([fetcher.normalizePlace(fakePlace(1), QUERY)]);
    const mirror = JSON.parse(fs.readFileSync(config.LEADS_JSON, 'utf8'));
    assert.strictEqual(mirror.count, 1);
    assert.strictEqual(mirror.leads[0].name, 'עסק מספר 1');
  });

  await test('no temp file is left behind after a write', () => {
    resetState();
    database.upsertLeads([fetcher.normalizePlace(fakePlace(1), QUERY)]);
    assert.ok(!fs.existsSync(`${config.LEADS_CSV}.tmp`), 'leads.csv.tmp should have been renamed away');
  });

  // ---- Config validation -------------------------------------------------
  await test('config rejects a bad cron expression and a bad timezone', () => {
    const savedSchedule = config.CRON_SCHEDULE;
    const savedTz = config.CRON_TIMEZONE;

    config.CRON_SCHEDULE = 'every other tuesday';
    assert.ok(config.collectProblems().some((p) => p.includes('CRON_SCHEDULE')));
    config.CRON_SCHEDULE = savedSchedule;

    config.CRON_TIMEZONE = 'Mars/Olympus_Mons';
    assert.ok(config.collectProblems().some((p) => p.includes('CRON_TIMEZONE')));
    config.CRON_TIMEZONE = savedTz;
  });

  await test('config builds the category × location matrix', () => {
    assert.strictEqual(config.QUERIES.length, config.CATEGORIES.length * config.LOCATIONS.length);
    assert.ok(config.QUERIES[0].text.includes(config.CATEGORIES[0]));
    assert.ok(config.QUERIES[0].text.includes(config.LOCATIONS[0]));
  });

  // ---- Report ------------------------------------------------------------
  console.log('\nOffline test suite\n');
  console.log(results.join('\n'));
  console.log(
    `\n${results.length - failures}/${results.length} passed${failures ? ` — ${failures} FAILED` : ''}\n`
  );

  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

run();
