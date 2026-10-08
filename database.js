'use strict';

/**
 * database.js — the lead table (CSV) with deduplication and safe writes.
 *
 * Storage decisions worth knowing:
 *
 * - Whole-file rewrite, not append. Appending is cheaper but cannot refresh a
 *   row whose phone number changed, and refresh-on-rerun is a requirement.
 *   At lead-list scale (thousands of rows) a full rewrite is milliseconds.
 *
 * - Writes are ATOMIC: build the whole file in memory, write `leads.csv.tmp`,
 *   then rename over the real file. rename(2) is atomic on POSIX, so a crash or
 *   a PM2 restart mid-write can never leave a truncated lead table. Losing a
 *   week of harvesting to a half-written file is not an acceptable failure.
 *
 * - The CSV is written with a UTF-8 BOM. Without it Excel opens Hebrew business
 *   names as mojibake ("×ž×¡×¢×“×ª"). Everything else (Sheets, pandas, csv-parse)
 *   handles the BOM transparently.
 */

const fs = require('fs');

const { parse } = require('csv-parse/sync');
const { createObjectCsvStringifier } = require('csv-writer');

const config = require('./config');
const logger = require('./logger');

const BOM = '﻿';

// Column order = reading order. The three requested fields lead; enrichment
// (free, because we are already on the Enterprise SKU) follows.
const COLUMNS = [
  { id: 'name', title: 'Business Name' },
  { id: 'phone', title: 'Phone Number' },
  { id: 'category', title: 'Category' },
  { id: 'address', title: 'Address' },
  { id: 'website', title: 'Website' },
  { id: 'rating', title: 'Rating' },
  { id: 'user_ratings', title: 'Review Count' },
  { id: 'business_status', title: 'Status' },
  { id: 'search_query', title: 'Search Query' },
  { id: 'search_category', title: 'Search Category' },
  { id: 'search_location', title: 'Search Location' },
  { id: 'place_id', title: 'Place ID' },
  { id: 'first_seen_at', title: 'First Seen' },
  { id: 'last_seen_at', title: 'Last Seen' },
];

const COLUMN_IDS = COLUMNS.map((column) => column.id);

// Fields refreshed when a business is seen again. `first_seen_at` and the
// `search_*` attribution are intentionally NOT here: they record where the lead
// originally came from, which is history and should not be rewritten.
const REFRESHABLE_FIELDS = [
  'name',
  'phone',
  'category',
  'address',
  'website',
  'rating',
  'user_ratings',
  'business_status',
];

/**
 * Dedupe key for phone numbers.
 *
 * "03-682-0387" and "+972 3-682-0387" are the same business, so comparing raw
 * strings would duplicate it. Digits-only comparison is not enough either,
 * because the national and international forms differ at the FRONT: the
 * international form carries a country code (972) where the national form
 * carries a trunk prefix (0).
 *
 *   03-682-0387      -> 036820387    (9 digits)
 *   +972 3-682-0387  -> 97236820387  (11 digits)
 *                          ^^^^^^^^ the last 8 digits are the shared part
 *
 * Keying on the last 8 digits survives that difference. It generalizes past
 * Israel too — US (+1) and UK (+44) numbers align on the last 8 the same way.
 * Eight rather than nine is a deliberate trade: slightly more collision risk in
 * exchange for actually catching the international/national duplicate, and this
 * is only the SECONDARY key — place_id remains authoritative.
 */
function phoneKey(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 8) return ''; // too short to trust as an identity
  return digits.slice(-8);
}

function ensureDataDir() {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
}

/**
 * Read the existing lead table.
 * A missing file is the normal first run and yields []. A CORRUPT file is not
 * silently discarded — that would delete the user's leads on the next write —
 * so it is backed up and reported instead.
 * @returns {object[]}
 */
function readLeads() {
  let raw;
  try {
    raw = fs.readFileSync(config.LEADS_CSV, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  if (!raw.trim()) return [];

  try {
    const records = parse(raw, {
      columns: (header) => header.map((title) => {
        const match = COLUMNS.find((column) => column.title === title);
        return match ? match.id : title;
      }),
      bom: true, // strip the BOM we wrote, rather than folding it into column 1
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });
    return records;
  } catch (err) {
    const backup = `${config.LEADS_CSV}.corrupt-${Date.now()}`;
    fs.copyFileSync(config.LEADS_CSV, backup);
    logger.error(
      `leads.csv could not be parsed; it has been preserved at ${backup}. ` +
        'Refusing to treat it as empty so existing leads are not lost.',
      err
    );
    throw err;
  }
}

/** Serialize rows to a BOM-prefixed CSV string. */
function toCsv(rows) {
  const stringifier = createObjectCsvStringifier({ header: COLUMNS });
  const body = rows.map((row) => {
    // Normalize shape so a missing field becomes "" rather than "undefined".
    const normalized = {};
    for (const id of COLUMN_IDS) normalized[id] = row[id] === undefined || row[id] === null ? '' : row[id];
    return normalized;
  });
  return BOM + stringifier.getHeaderString() + stringifier.stringifyRecords(body);
}

/** Write `content` to `target` atomically via a temp file + rename. */
function writeAtomic(target, content) {
  ensureDataDir();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

/**
 * Merge freshly fetched leads into the table.
 *
 * Handles three kinds of duplicate:
 *   1. against rows already on disk,
 *   2. against rows added earlier in this same batch,
 *   3. the same business returned by two overlapping queries
 *      (e.g. a Ramat Gan restaurant showing up in a Tel Aviv search).
 *
 * @param {object[]} incoming
 * @returns {{inserted:number, updated:number, total:number}}
 */
function upsertLeads(incoming) {
  const existing = readLeads();

  const byPlaceId = new Map();
  const byPhone = new Map();

  for (const row of existing) {
    if (row.place_id) byPlaceId.set(row.place_id, row);
    const key = phoneKey(row.phone);
    if (key) byPhone.set(key, row);
  }

  const now = new Date().toISOString();
  let inserted = 0;
  let updated = 0;

  for (const lead of incoming) {
    if (!lead || !lead.place_id) continue;

    const key = phoneKey(lead.phone);
    const match = byPlaceId.get(lead.place_id) || (key ? byPhone.get(key) : undefined);

    if (match) {
      for (const field of REFRESHABLE_FIELDS) {
        // Never overwrite a known value with a blank one: a field missing from
        // this response is far more likely to be an omission than a deletion.
        if (lead[field] !== undefined && lead[field] !== '') match[field] = lead[field];
      }
      match.last_seen_at = now;
      if (!match.first_seen_at) match.first_seen_at = now;
      updated += 1;
    } else {
      const row = { ...lead, first_seen_at: now, last_seen_at: now };
      existing.push(row);
      byPlaceId.set(row.place_id, row);
      if (key) byPhone.set(key, row);
      inserted += 1;
    }
  }

  writeAtomic(config.LEADS_CSV, toCsv(existing));

  if (config.WRITE_JSON_MIRROR) {
    // Mirror for a future dashboard: fetch('data/leads.json') with no CSV parsing.
    writeAtomic(
      config.LEADS_JSON,
      JSON.stringify({ generatedAt: now, count: existing.length, leads: existing }, null, 2)
    );
  }

  return { inserted, updated, total: existing.length };
}

/** Convenience for a future dashboard / API layer. */
function getStats() {
  const leads = readLeads();
  const byCategory = {};
  const byLocation = {};
  for (const lead of leads) {
    if (lead.category) byCategory[lead.category] = (byCategory[lead.category] || 0) + 1;
    if (lead.search_location) byLocation[lead.search_location] = (byLocation[lead.search_location] || 0) + 1;
  }
  return { total: leads.length, byCategory, byLocation };
}

module.exports = {
  readLeads,
  upsertLeads,
  getStats,
  phoneKey,
  toCsv,
  writeAtomic,
  COLUMNS,
  CSV_PATH: config.LEADS_CSV,
};
