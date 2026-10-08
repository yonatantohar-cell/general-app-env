'use strict';

/**
 * index.js — entry point. Wires config + fetcher + database together and keeps
 * the whole thing alive on a cron schedule.
 *
 *   npm start        run forever, harvesting on the configured schedule
 *   npm run once     run a single harvest and exit (use this to test setup)
 *
 * The guiding rule for everything below: an unattended process must never die
 * quietly, and must never lose data it already collected.
 */

const cron = require('node-cron');

const config = require('./config');
const logger = require('./logger');
const fetcher = require('./fetcher');
const database = require('./database');
const usage = require('./usage');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let isRunning = false;
let shuttingDown = false;

// ---------------------------------------------------------------------------
// The harvest
// ---------------------------------------------------------------------------

/**
 * One full pass over every configured query.
 *
 * Failure policy: a single bad query must not cost the whole night's work, so
 * each query is isolated. Whatever was collected is written even if the run
 * ends early — losing 25 good queries because the 26th failed would be absurd.
 *
 * @param {string} trigger what started this run, for the log
 */
async function runJob(trigger = 'manual') {
  // A slow run must never overlap the next cron fire: two passes would
  // double-spend the API budget and race on leads.csv.
  if (isRunning) {
    logger.warn(`Harvest already in progress; skipping this ${trigger} trigger.`);
    return { skipped: true };
  }

  isRunning = true;
  const startedAt = Date.now();
  const collected = [];
  const stats = { queriesRun: 0, queriesFailed: 0, pages: 0, rawResults: 0, droppedNoPhone: 0 };
  let stoppedEarly = null;

  logger.info(`=== Harvest started (trigger: ${trigger}) — ${config.QUERIES.length} queries queued ===`);
  logger.info(`Free-tier budget: ${JSON.stringify(usage.summary())}`);

  try {
    for (const query of config.QUERIES) {
      if (shuttingDown) {
        stoppedEarly = 'shutdown requested';
        break;
      }

      try {
        const result = await fetcher.searchQuery(query);
        collected.push(...result.leads);
        stats.queriesRun += 1;
        stats.pages += result.pages;
        stats.rawResults += result.rawCount;
        stats.droppedNoPhone += result.droppedNoPhone;
        logger.info(`  ✓ "${query.text}" → ${result.leads.length} lead(s) from ${result.pages} page(s)`);
      } catch (err) {
        // Budget exhaustion is an expected, orderly stop — not a failure.
        if (err instanceof usage.BudgetExhaustedError) {
          stoppedEarly = 'monthly free-tier budget reached';
          logger.warn(err.message);
          break;
        }
        stats.queriesFailed += 1;
        logger.error(`  ✗ Query "${query.text}" failed; continuing with the rest`, err);
      }

      if (config.DELAY_BETWEEN_REQUESTS_MS > 0) await sleep(config.DELAY_BETWEEN_REQUESTS_MS);
    }

    // Always persist what we have, including after an early stop.
    let writeResult = { inserted: 0, updated: 0, total: database.readLeads().length };
    if (collected.length > 0) {
      writeResult = database.upsertLeads(collected);
    }

    // Note: "pages fetched" can be lower than the quota actually spent, because
    // a retried 429/5xx still consumed a call on Google's side. `budget left`
    // below is the authoritative number.
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    logger.info(
      `=== Harvest finished in ${seconds}s — ` +
        `${writeResult.inserted} new, ${writeResult.updated} refreshed, ${writeResult.total} total leads ===`
    );
    logger.info(
      `Queries: ${stats.queriesRun} ok / ${stats.queriesFailed} failed | ` +
        `pages fetched: ${stats.pages} | raw results: ${stats.rawResults} | ` +
        `dropped (no phone): ${stats.droppedNoPhone} | budget left: ${usage.summary().remaining}`
    );
    if (stoppedEarly) logger.warn(`Run ended early: ${stoppedEarly}`);

    return { ...stats, ...writeResult, stoppedEarly };
  } catch (err) {
    // Anything not caught per-query: log loudly, but keep the process alive so
    // the next scheduled run still happens.
    logger.error('Harvest run failed unexpectedly', err);
    return { failed: true, error: err.message };
  } finally {
    isRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Process-level safety net
// ---------------------------------------------------------------------------

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection (process kept alive)', reason instanceof Error ? reason : String(reason));
});

process.on('uncaughtException', (err) => {
  // Log and stay up: a scheduler that exits on one bad tick stops being a
  // scheduler. PM2 will restart us if the process ever does die.
  logger.error('Uncaught exception (process kept alive)', err);
});

function handleShutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully.`);
  shuttingDown = true;

  if (!isRunning) process.exit(0);

  // A harvest is mid-flight. Writes are atomic, so waiting for the current
  // query to finish is enough; bail out after 30s regardless.
  logger.info('Waiting for the in-flight harvest to finish…');
  const deadline = Date.now() + 30000;
  const timer = setInterval(() => {
    if (!isRunning || Date.now() > deadline) {
      clearInterval(timer);
      process.exit(0);
    }
  }, 250);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  // Fail fast and loudly on bad configuration — the alternative is a silent
  // 403 at 2am that nobody notices for a week.
  try {
    config.validate();
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }

  const runOnce = process.argv.includes('--once');

  logger.info('--------------------------------------------------------------');
  logger.info(' Lead Generation System');
  logger.info(`   queries      : ${config.QUERIES.length} (${config.CATEGORIES.length} categories × ${config.LOCATIONS.length} locations)`);
  logger.info(`   locale       : ${config.LANGUAGE_CODE} / ${config.REGION_CODE}`);
  logger.info(`   output       : ${config.LEADS_CSV}`);
  logger.info(`   free tier    : ${config.MONTHLY_CALL_BUDGET} calls/month (≈${config.MONTHLY_CALL_BUDGET * 20} leads)`);
  logger.info('--------------------------------------------------------------');

  if (runOnce) {
    logger.info('Running a single harvest (--once), then exiting.');
    const result = await runJob('--once');
    process.exit(result && result.failed ? 1 : 0);
  }

  const task = cron.schedule(config.CRON_SCHEDULE, () => runJob('cron'), {
    timezone: config.CRON_TIMEZONE,
    name: 'lead-harvest',
  });

  const nextRun = task.getNextRun();
  logger.info(
    `Scheduled "${config.CRON_SCHEDULE}" (${config.CRON_TIMEZONE}). ` +
      `Next run: ${nextRun ? nextRun.toISOString() : 'unknown'}`
  );

  if (config.RUN_ON_START) {
    logger.info('RUN_ON_START is on — harvesting immediately.');
    await runJob('startup');
  }

  logger.info('Idle. Leave this process running (PM2 recommended); it will wake on schedule.');
}

// Only auto-start when executed directly, so tests can require this file safely.
if (require.main === module) {
  main().catch((err) => {
    logger.error('Fatal error during startup', err);
    process.exit(1);
  });
}

module.exports = { runJob };
