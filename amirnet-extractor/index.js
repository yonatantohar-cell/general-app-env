'use strict';

/**
 * index.js — orchestrates the extraction.
 *
 *   node index.js --from-url https://amirnetwords.com/tests
 *   node index.js --from-dir ./saved-pages        # pages you saved yourself
 *   node index.js --from-url <url> --refresh      # ignore the local cache
 *   node index.js --from-url <url> --limit 2      # try two pages first
 *
 * Writes output/json/*.json, output/all-simulations.json, output/markdown/*.md
 */

const fs = require('fs');
const path = require('path');

const { fetchPageCached, readLocalPages, sleep, DEFAULTS } = require('./fetch.js');
const { parseSimulation, parseSimulationList } = require('./parse.js');
const { renderSimulation, renderIndex } = require('./render.js');

const OUT_DIR = path.join(__dirname, 'output');
const JSON_DIR = path.join(OUT_DIR, 'json');
const MD_DIR = path.join(OUT_DIR, 'markdown');
const ERROR_LOG = path.join(OUT_DIR, 'errors.log');

function argValue(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function logError(message, err) {
  const line = `[${new Date().toISOString()}] ${message}${err ? ` :: ${err.stack || err.message}` : ''}`;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(ERROR_LOG, line + '\n', 'utf8');
  console.error(`  ✗ ${message}`);
}

function writeOutputs(simulations) {
  fs.mkdirSync(JSON_DIR, { recursive: true });
  fs.mkdirSync(MD_DIR, { recursive: true });

  for (const simulation of simulations) {
    const stem = `simulation-${String(simulation.id).padStart(2, '0')}`;
    fs.writeFileSync(path.join(JSON_DIR, `${stem}.json`), JSON.stringify(simulation, null, 2), 'utf8');
    fs.writeFileSync(path.join(MD_DIR, `${stem}.md`), renderSimulation(simulation), 'utf8');
  }

  fs.writeFileSync(
    path.join(OUT_DIR, 'all-simulations.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        count: simulations.length,
        totalQuestions: simulations.reduce((sum, s) => sum + (s.questions || []).length, 0),
        simulations,
      },
      null,
      2
    ),
    'utf8'
  );

  fs.writeFileSync(path.join(MD_DIR, 'README.md'), renderIndex(simulations), 'utf8');
}

async function fromUrl(indexUrl, { refresh, limit }) {
  console.log(`\nDiscovering simulations from ${indexUrl}`);
  const indexPage = await fetchPageCached(indexUrl, { refresh });
  console.log(
    `  index page: ${indexPage.bytes} bytes, charset ${indexPage.charset}` +
      (indexPage.overridden ? '  (site mis-declared its charset — corrected)' : '')
  );

  let targets = parseSimulationList(indexPage.html, indexUrl);
  console.log(`  found ${targets.length} candidate simulation link(s)`);

  if (targets.length === 0) {
    console.error(
      '\n  No simulation links found. Run `node inspect.js <url>` — the content is probably\n' +
        '  rendered by JavaScript or served from an API, which needs a different approach.\n'
    );
    return [];
  }

  if (limit) targets = targets.slice(0, Number(limit));

  const simulations = [];
  for (const [position, target] of targets.entries()) {
    try {
      const page = await fetchPageCached(target.url, { refresh });
      const { simulation, strategy } = parseSimulation(page.html, {
        id: position + 1,
        title: target.title,
        url: target.url,
      });

      if (simulation.questions.length === 0) {
        logError(`"${target.url}" parsed to 0 questions (no strategy matched)`);
      } else {
        console.log(
          `  ✓ ${String(position + 1).padStart(2)}. ${simulation.questions.length} question(s) ` +
            `via ${strategy}  — ${simulation.title.slice(0, 40)}`
        );
      }
      simulations.push(simulation);
    } catch (err) {
      // One bad page must not cost the whole run.
      logError(`Failed on ${target.url}`, err);
    }

    if (!DEFAULTS.politeDelayMs || position === targets.length - 1) continue;
    await sleep(DEFAULTS.politeDelayMs);
  }

  return simulations;
}

function fromDir(dir) {
  console.log(`\nReading saved pages from ${dir}`);
  const pages = readLocalPages(dir);
  console.log(`  found ${pages.length} HTML file(s)`);

  const simulations = [];
  pages.forEach((page, index) => {
    try {
      const { simulation, strategy } = parseSimulation(page.html, {
        id: index + 1,
        url: page.url,
      });
      if (simulation.questions.length === 0) logError(`${page.sourceName} parsed to 0 questions`);
      else
        console.log(
          `  ✓ ${String(index + 1).padStart(2)}. ${simulation.questions.length} question(s) via ${strategy}  — ${page.sourceName}`
        );
      simulations.push(simulation);
    } catch (err) {
      logError(`Failed on ${page.sourceName}`, err);
    }
  });

  return simulations;
}

async function main() {
  const indexUrl = argValue('--from-url');
  const dir = argValue('--from-dir');
  const refresh = process.argv.includes('--refresh');
  const limit = argValue('--limit');

  if (!indexUrl && !dir) {
    console.error('usage: node index.js (--from-url <url> | --from-dir <dir>) [--refresh] [--limit N]');
    process.exit(1);
  }

  const simulations = dir ? fromDir(dir) : await fromUrl(indexUrl, { refresh, limit });

  if (simulations.length === 0) {
    console.error('\nNothing extracted. See output/errors.log\n');
    process.exit(1);
  }

  writeOutputs(simulations);

  const totalQuestions = simulations.reduce((sum, s) => sum + (s.questions || []).length, 0);
  const withAnswers = simulations.reduce(
    (sum, s) => sum + (s.questions || []).filter((q) => q.correctAnswer).length,
    0
  );

  console.log(`\nWrote ${simulations.length} simulation(s), ${totalQuestions} question(s)`);
  console.log(`  JSON     : ${path.relative(process.cwd(), JSON_DIR)}/`);
  console.log(`  Markdown : ${path.relative(process.cwd(), MD_DIR)}/`);
  if (withAnswers === 0) {
    console.log('  note     : no correct answers were present on the pages — extracted without an answer key.');
  }
  console.log('\nNow run: node validate.js --expect 20\n');
}

if (require.main === module) {
  main().catch((err) => {
    logError('Fatal error', err);
    process.exit(1);
  });
}

module.exports = { fromUrl, fromDir, writeOutputs };
