// Performance regression gate (PLAN M5): compares this run's bench results with a committed baseline.
//   node bench/compare.mjs <results.json> [--baseline bench/baseline/<platform>.json] [--report-only]
//   node bench/compare.mjs <results.json>... --update     baseline = per-measure median over several CI runs
// Each gated measure is divided by a calibration timed in the same run (git or CPU), so a slower or faster
// CI machine cancels out; a measure fails when its normalised median is more than THRESHOLD above baseline.
// Measures not listed here are covered by their absolute budgets in bench.ts only: process start-up (spiky on
// shared runners), measures of a few milliseconds (10% is below timer noise), and whole-file cold blame
// (swung 28% between two CI runs of the same code even after normalising).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const THRESHOLD = 0.1;
const CAL = { git: 'calibration: git log of 100k commits', cpu: 'calibration: JS parse/sort/map, 200k rows' };
/** Measure → the calibration that shares its kind of work. */
export const GATED = {
  'index: cold full load, 100k commits': 'git',
  'index: open from disk (new session)': 'cpu',
  'index: incremental, +1 commit then branch delete': 'git',
  'graph: first page, cold (lays out all 100k rows)': 'cpu',
  'graph wide: first page, cold (lays out all 100k rows)': 'cpu',
  'graph: current-branch view, first page (builds the view)': 'cpu',
  'graph: search 100k subjects/authors (text)': 'cpu',
  'blame cold: recently changed line shown (streamed)': 'git',
  'blame cold: line unchanged since first commit (documented)': 'git',
};

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

/** Normalised medians of the gated measures in a results file. */
export function normalise(results) {
  const med = Object.fromEntries(results.results.map((r) => [r.name, median(r.samples)]));
  const out = {};
  for (const [name, kind] of Object.entries(GATED)) {
    const cal = med[CAL[kind]];
    if (med[name] !== undefined && cal) out[name] = med[name] / cal;
  }
  return out;
}

/** Regressions of `current` against `baseline` (both normalised), worst first. */
export function regressions(current, baseline, threshold = THRESHOLD) {
  return Object.entries(current)
    .filter(([n]) => baseline[n] !== undefined)
    .map(([n, v]) => ({ name: n, change: v / baseline[n] - 1 }))
    .filter((r) => r.change > threshold)
    .sort((a, b) => b.change - a.change);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const bi = args.indexOf('--baseline');
  const files = args.filter((a, i) => !a.startsWith('--') && i !== bi + 1);
  const file = files[0];
  if (!file) {
    console.error('usage: node bench/compare.mjs <results.json> [--baseline file] [--update] [--report-only]');
    process.exit(2);
  }
  const results = JSON.parse(readFileSync(file, 'utf8'));
  const platform = results.machine?.platform ?? process.platform;
  const baselineFile = bi >= 0 ? args[bi + 1] : path.join(path.dirname(new URL(import.meta.url).pathname), 'baseline', `${platform}.json`);
  const current = normalise(results);
  if (args.includes('--update')) {
    // One run is noisy: take each measure's median over every results file given.
    const runs = files.map((f) => normalise(JSON.parse(readFileSync(f, 'utf8'))));
    const merged = Object.fromEntries(Object.keys(current).map((n) => [n, median(runs.map((r) => r[n]).filter((v) => v !== undefined))]));
    mkdirSync(path.dirname(baselineFile), { recursive: true });
    const from = files.map((f) => JSON.parse(readFileSync(f, 'utf8')).date);
    writeFileSync(baselineFile, JSON.stringify({ from, machine: results.machine, runs: files.length, normalised: merged }, null, 2) + '\n');
    console.log(`baseline written: ${baselineFile} (${Object.keys(merged).length} measures, ${files.length} runs)`);
    process.exit(0);
  }
  if (!existsSync(baselineFile)) {
    console.log(`No baseline at ${baselineFile}: nothing to compare yet (run with --update on a CI result to create one).`);
    process.exit(0);
  }
  const baseline = JSON.parse(readFileSync(baselineFile, 'utf8')).normalised;
  for (const [n, v] of Object.entries(current)) {
    const b = baseline[n];
    const change = b ? `${((v / b - 1) * 100).toFixed(1).padStart(6)}%` : '   new';
    console.log(`${change}  ${n}`);
  }
  const bad = regressions(current, baseline);
  if (!bad.length) {
    console.log(`\nno regression over ${THRESHOLD * 100}% (normalised by same-run calibrations)`);
    process.exit(0);
  }
  console.error(`\nREGRESSION over ${THRESHOLD * 100}%: ${bad.map((r) => `${r.name} (+${(r.change * 100).toFixed(0)}%)`).join('; ')}`);
  process.exit(args.includes('--report-only') ? 0 : 1);
}
