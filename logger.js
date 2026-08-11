'use strict';

/**
 * logger.js — leveled logging to console + rotating-ish files.
 *
 * Two sinks, deliberately:
 *   logs/run.log    every line (the audit trail of what the robot did at 2am)
 *   logs/error.log  warnings and errors ONLY (the file you actually check)
 *
 * Keeping errors in their own file is the difference between "grep 40k lines"
 * and "cat error.log" when something breaks unattended.
 */

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const LOG_DIR = path.join(__dirname, 'logs');
const RUN_LOG = path.join(LOG_DIR, 'run.log');
const ERROR_LOG = path.join(LOG_DIR, 'error.log');

// Read the level directly from the environment rather than from config.js:
// config.js needs to log its own validation failures, so it cannot be a
// dependency of the logger without creating a require cycle.
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

fs.mkdirSync(LOG_DIR, { recursive: true });

/**
 * Errors do not survive JSON.stringify (message and stack are non-enumerable),
 * which is the classic way an unattended service ends up with "{}" in its log
 * exactly when something went wrong. Unwrap them by hand.
 */
function formatDetail(detail) {
  if (detail === undefined || detail === null) return '';
  if (detail instanceof Error) {
    const extra = detail.details ? ` | details=${JSON.stringify(detail.details)}` : '';
    return ` | ${detail.name}: ${detail.message}${extra}\n${detail.stack || ''}`;
  }
  if (typeof detail === 'string') return ` | ${detail}`;
  try {
    return ` | ${JSON.stringify(detail)}`;
  } catch {
    return ` | [unserializable detail]`;
  }
}

function append(file, line) {
  try {
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch (err) {
    // If logging itself fails (disk full, permissions), say so on stderr and
    // carry on. A broken log must never take the harvester down with it.
    process.stderr.write(`[logger] cannot write ${file}: ${err.message}\n`);
  }
}

function log(level, message, detail) {
  if (LEVELS[level] < threshold) return;

  const line = `[${new Date().toISOString()}] [${level.toUpperCase().padEnd(5)}] ${message}${formatDetail(detail)}`;

  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');

  append(RUN_LOG, line);
  if (LEVELS[level] >= LEVELS.warn) append(ERROR_LOG, line);
}

module.exports = {
  debug: (msg, detail) => log('debug', msg, detail),
  info: (msg, detail) => log('info', msg, detail),
  warn: (msg, detail) => log('warn', msg, detail),
  error: (msg, detail) => log('error', msg, detail),
  paths: { LOG_DIR, RUN_LOG, ERROR_LOG },
};
