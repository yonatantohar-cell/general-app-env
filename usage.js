'use strict';

/**
 * usage.js — persistent monthly API-call counter enforcing the free tier.
 *
 * Why this exists: because we request phone numbers, every Text Search call
 * bills at Google's *Enterprise* SKU — 1,000 free calls per month, then real
 * money (~$35 per 1,000). An unattended job that silently rolls past the free
 * tier is exactly the failure mode nobody notices until the invoice arrives.
 *
 * State lives in data/usage.json and survives restarts, so a PM2 restart loop
 * cannot reset the counter and re-spend the budget.
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const logger = require('./logger');

/** Distinct error type so the runner can stop *calmly* rather than treat it as a crash. */
class BudgetExhaustedError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'BudgetExhaustedError';
    this.details = details;
  }
}

/**
 * Month key in the configured timezone. Google resets free tiers on the 1st;
 * using the local billing-ish month avoids resetting a day early or late.
 */
function currentMonthKey(now = new Date()) {
  // en-CA formats as YYYY-MM-DD, so slicing to 7 chars yields YYYY-MM.
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.CRON_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return formatted.slice(0, 7);
}

function emptyState(month) {
  return { month, calls: 0, updatedAt: new Date().toISOString() };
}

function readState() {
  const month = currentMonthKey();
  try {
    const raw = fs.readFileSync(config.USAGE_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    // New month -> the free allowance renews, so reset the counter.
    if (parsed.month !== month) {
      logger.info(`Monthly quota reset: ${parsed.month} -> ${month} (previous total: ${parsed.calls} calls)`);
      return emptyState(month);
    }
    return { month: parsed.month, calls: Number(parsed.calls) || 0, updatedAt: parsed.updatedAt };
  } catch (err) {
    // Missing file is the normal first run. Corrupt file is not fatal either:
    // losing the counter must never stop the harvest, so start fresh and warn.
    if (err.code !== 'ENOENT') {
      logger.warn(`usage.json unreadable (${err.message}); starting a fresh counter for ${month}`);
    }
    return emptyState(month);
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(config.USAGE_FILE), { recursive: true });
    fs.writeFileSync(
      config.USAGE_FILE,
      JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
  } catch (err) {
    logger.warn('Could not persist usage.json; the budget guard may undercount', err);
  }
}

/** Calls already spent this month. */
function getUsedCalls() {
  return readState().calls;
}

/** Calls still free this month (never negative). */
function getRemainingCalls() {
  return Math.max(0, config.MONTHLY_CALL_BUDGET - getUsedCalls());
}

/**
 * Reserve one API call before it is made.
 * Counting *before* the request is deliberate: a request that fails still
 * consumed quota on Google's side, so counting after would undercount.
 * @throws {BudgetExhaustedError} when the monthly cap is reached.
 */
function reserveCall() {
  const state = readState();

  if (state.calls >= config.MONTHLY_CALL_BUDGET) {
    throw new BudgetExhaustedError(
      `Monthly free-tier budget reached: ${state.calls}/${config.MONTHLY_CALL_BUDGET} calls used in ${state.month}. ` +
        'Harvesting is paused until the quota resets on the 1st. ' +
        'Raise MONTHLY_CALL_BUDGET in .env only if you accept paid usage.',
      { month: state.month, used: state.calls, budget: config.MONTHLY_CALL_BUDGET }
    );
  }

  state.calls += 1;
  writeState(state);
  return { used: state.calls, remaining: config.MONTHLY_CALL_BUDGET - state.calls };
}

function summary() {
  const state = readState();
  return {
    month: state.month,
    used: state.calls,
    budget: config.MONTHLY_CALL_BUDGET,
    remaining: Math.max(0, config.MONTHLY_CALL_BUDGET - state.calls),
  };
}

module.exports = {
  BudgetExhaustedError,
  currentMonthKey,
  getUsedCalls,
  getRemainingCalls,
  reserveCall,
  summary,
};
