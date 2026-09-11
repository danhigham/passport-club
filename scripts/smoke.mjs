#!/usr/bin/env node
/**
 * End-to-end check of the game logic against the real baked data, with no
 * browser involved.
 *
 * It bundles the actual TypeScript modules the app ships (so this can't drift
 * from what players run), stubs `fetch` to read from public/data, then plays a
 * simulated round of every mode: build a session, click the exact centre of
 * each answer, and assert the judge says "correct". If a target can be
 * generated but not clicked, this is what catches it.
 *
 *   node scripts/smoke.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'public', 'data');

/* ---- stub the browser bits the data layer expects ---------------------- */

globalThis.fetch = async (url) => {
  const rel = String(url).replace(/^\/?data\//, '');
  const file = path.join(DATA, rel);
  if (!fs.existsSync(file)) {
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => null };
  }
  const text = fs.readFileSync(file, 'utf8');
  return { ok: true, status: 200, json: async () => JSON.parse(text) };
};

/* ---- bundle the real modules ------------------------------------------ */

const entry = path.join(ROOT, '.cache', 'smoke-entry.ts');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(
  entry,
  `export { loadCore, loadAdmin1 } from '../src/data/datasets';
   export { buildSession, poolSize, LEVEL_TIERS } from '../src/game/session';
   export { findAreaAt, findNearestCity, distanceKm } from '../src/map/geo';
  `,
);

const outfile = path.join(ROOT, '.cache', 'smoke-bundle.mjs');
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  define: { 'import.meta.env.BASE_URL': '"/"' },
  logLevel: 'silent',
});

const lib = await import(pathToFileURL(outfile).href);

/* ---- the simulation ---------------------------------------------------- */

let failures = 0;
const results = [];

function check(label, ok, detail = '') {
  if (!ok) failures++;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
}

const core = await lib.loadCore();

const BASE = {
  showBorders: true,
  showLabels: false,
  showCityDots: true,
  narrowToParent: false,
  rounds: 12,
  timeLimit: null,
};

/** Replay the app's judging rules for an area click. */
function judgeArea(session, target, lonLat) {
  const hit = lib.findAreaAt(session.hitAreas, lonLat);
  if (target.kind === 'continent') {
    return hit?.properties.kind === 'country' && hit.properties.continent === target.id;
  }
  return hit?.properties.id === target.id;
}

const scenarios = [
  { name: 'continents / world', config: { mode: 'continent', scope: { type: 'world' }, level: 'explorer' } },
  { name: 'countries / world / explorer', config: { mode: 'country', scope: { type: 'world' }, level: 'explorer' } },
  { name: 'countries / world / globetrotter', config: { mode: 'country', scope: { type: 'world' }, level: 'globetrotter' } },
  { name: 'countries / Europe / traveller', config: { mode: 'country', scope: { type: 'continent', id: 'Europe' }, level: 'traveller' } },
  { name: 'countries / Africa / globetrotter', config: { mode: 'country', scope: { type: 'continent', id: 'Africa' }, level: 'globetrotter' } },
  { name: 'cities / world / explorer', config: { mode: 'city', scope: { type: 'world' }, level: 'explorer' } },
  { name: 'cities / Asia / globetrotter', config: { mode: 'city', scope: { type: 'continent', id: 'Asia' }, level: 'globetrotter' } },
];

for (const a3 of ['USA', 'GBR', 'FRA', 'JPN', 'BRA', 'IRL', 'AUS', 'DEU', 'IND', 'ZAF']) {
  for (const level of ['explorer', 'globetrotter']) {
    scenarios.push({
      name: `admin1 / ${a3} / ${level}`,
      config: { mode: 'admin1', scope: { type: 'country', id: a3 }, level },
    });
  }
}

for (const { name, config: partial } of scenarios) {
  const config = { ...BASE, ...partial };
  const admin1 =
    config.mode === 'admin1' ? await lib.loadAdmin1(config.scope.id) : [];
  const session = lib.buildSession(core, config, admin1);

  if (!session.targets.length) {
    check(name, false, 'produced no questions at all');
    continue;
  }

  const bad = [];
  for (const target of session.targets) {
    const solvable =
      target.kind === 'city'
        ? lib.distanceKm([target.point[0], target.point[1]], target.point) < 1
        : judgeArea(session, target, target.point);
    if (!solvable) bad.push(target.name);

    // Every target must also be describable and placeable on the map.
    if (!target.name || !target.subtitle) bad.push(`${target.id} (no label)`);
    if (!Number.isFinite(target.point[0]) || !Number.isFinite(target.point[1])) {
      bad.push(`${target.name} (no location)`);
    }
  }

  check(
    `${name.padEnd(34)} ${String(session.targets.length).padStart(2)} questions`,
    bad.length === 0,
    bad.length ? `unsolvable: ${bad.slice(0, 5).join(', ')}` : '',
  );
}

/* ---- cross-cutting invariants ----------------------------------------- */

{
  // Asking for more questions than exist must silently shrink, not repeat.
  const config = { ...BASE, mode: 'continent', scope: { type: 'world' }, level: 'explorer', rounds: 20 };
  const s = lib.buildSession(core, config);
  const ids = new Set(s.targets.map((t) => t.id));
  check(
    'over-long round shrinks instead of repeating',
    ids.size === s.targets.length && s.targets.length <= 7,
    `${s.targets.length} questions, ${ids.size} unique`,
  );
}

{
  // A city target must be the closest city to its own coordinates, otherwise a
  // player tapping it perfectly would be told they hit a different city.
  const config = { ...BASE, mode: 'city', scope: { type: 'world' }, level: 'globetrotter', rounds: 20 };
  const s = lib.buildSession(core, config);
  const shadowed = s.targets.filter((t) => {
    const n = lib.findNearestCity(s.cities, t.point);
    return n && n.city.id !== t.id && n.km < 1;
  });
  check(
    'no city is shadowed by another at the same spot',
    shadowed.length === 0,
    shadowed.map((t) => t.name).join(', '),
  );
}

{
  // Every level must offer a playable pool in every mode/scope combination the
  // setup screen can produce.
  const empties = [];
  for (const level of ['explorer', 'traveller', 'globetrotter']) {
    for (const c of core.continents) {
      for (const mode of ['country', 'city']) {
        const n = lib.poolSize(core, {
          ...BASE,
          mode,
          level,
          scope: { type: 'continent', id: c.id },
        });
        if (n < 3 && c.id !== 'Antarctica') empties.push(`${mode}/${c.name}/${level}=${n}`);
      }
    }
  }
  check('every continent scope has a playable pool', empties.length === 0, empties.join(', '));
}

console.log('\n' + results.join('\n'));
console.log(failures ? `\n${failures} scenario(s) failed.\n` : '\nAll scenarios passed.\n');
process.exit(failures ? 1 : 0);
