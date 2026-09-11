#!/usr/bin/env node
/**
 * Guard that runs before `dev` and `build`.
 *
 * The baked map data is ~21mb and fully reproducible from Natural Earth, so it
 * is deliberately kept out of git. That would otherwise leave a fresh clone
 * building an app whose map silently 404s, so if the data isn't there, fetch it
 * rather than failing with a mystery.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// One file from each of the three fetches, so a half-finished build is caught.
const REQUIRED = [
  'public/data/countries.topo.json',
  'public/data/cities.json',
  'public/data/admin1/index.json',
];

/**
 * The satellite base map is optional, so a missing texture is a warning rather
 * than a failure: without it the game falls back to the vector globe, which is
 * exactly what it did before the hybrid map existed.
 */
function ensureTextures() {
  if (existsSync(path.join(ROOT, 'public/textures/earth-4096.jpg'))) return;
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-texture.mjs')], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  if (res.status !== 0) {
    console.warn(
      '\nCould not build the globe texture (it needs ImageMagick).\n' +
        'The satellite base map will be unavailable; the vector globe still works.\n',
    );
  }
}

const missing = REQUIRED.filter((f) => !existsSync(path.join(ROOT, f)));
if (!missing.length) {
  ensureTextures();
  process.exit(0);
}

console.log('\nMap data is missing — building it now (one-off, a minute or two).\n');

const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-data.mjs')], {
  stdio: 'inherit',
  cwd: ROOT,
});

if (res.status !== 0) {
  console.error(
    '\nCould not build the map data. It needs one-time network access to\n' +
      'raw.githubusercontent.com. Run `npm run data` once you have a connection.\n',
  );
  process.exit(1);
}

ensureTextures();
