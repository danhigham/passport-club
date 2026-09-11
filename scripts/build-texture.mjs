#!/usr/bin/env node
/**
 * Base-map texture pipeline (hybrid map experiment).
 *
 * Downloads NASA's Blue Marble composite and prepares it for use as a globe
 * texture. The source is a single equirectangular image, which is exactly what
 * a sphere shader wants: no tile server, no API key, no per-frame network.
 *
 *   npm run texture
 *
 * Two sizes are produced. The small one is a few hundred kilobytes and shows
 * within a moment of load; the large one replaces it when it arrives, so the
 * globe is never blank while a couple of megabytes download.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'public', 'textures');

/**
 * NASA Visible Earth, "Blue Marble: Next Generation" (December 2004), with
 * topography and bathymetry. Public domain.
 */
const SOURCE = {
  url: 'https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200412.3x5400x2700.jpg',
  file: 'blue-marble-5400.jpg',
};

/**
 * Output sizes, in powers of two.
 *
 * Power-of-two dimensions matter: WebGL only allows repeat-wrapping and
 * mipmapping on such textures, and the globe needs wrapping because the
 * antimeridian runs straight through the middle of the sampled image.
 */
const SIZES = [
  { w: 1024, h: 512, quality: 78, name: 'earth-1024.jpg' },
  { w: 4096, h: 2048, quality: 82, name: 'earth-4096.jpg' },
];

const kb = (n) => (n / 1024).toFixed(0) + 'kb';

async function fetchSource() {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, SOURCE.file);
  if (fs.existsSync(file)) {
    console.log(`  cached  ${SOURCE.file}  ${kb(fs.statSync(file).size)}`);
    return file;
  }
  process.stdout.write(`  fetch   ${SOURCE.file} ... `);
  const res = await fetch(SOURCE.url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  console.log(kb(buf.length));
  return file;
}

async function main() {
  console.log('\nPassport Club texture build\n');
  const src = await fetchSource();
  fs.mkdirSync(OUT, { recursive: true });

  for (const size of SIZES) {
    const dest = path.join(OUT, size.name);
    execFileSync('magick', [
      src,
      '-resize',
      `${size.w}x${size.h}!`, // exact: the source is already 2:1 equirectangular
      '-strip',
      '-interlace',
      'Plane',
      '-quality',
      String(size.quality),
      dest,
    ]);
    console.log(`  wrote   ${size.name}  ${size.w}x${size.h}  ${kb(fs.statSync(dest).size)}`);
  }

  console.log('\nDone. Textures live in public/textures/\n');
}

main().catch((err) => {
  console.error('\nTexture build failed:', err.message);
  process.exit(1);
});
