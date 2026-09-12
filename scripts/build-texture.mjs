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
 * NASA Visible Earth, "Blue Marble: Next Generation", with topography and
 * bathymetry. Public domain.
 *
 * August, and the month matters more than anything else about this file. The
 * composites are cloudless, so what looks like cloud over Russia and northern
 * Europe is snow, and how much of it there is depends entirely on which month
 * you pick. Measured as the share of land between 50N and 75N that reads as
 * snow or ice:
 *
 *     December  69.9%      June       17.6%
 *     September 16.0%      July        7.5%
 *                          August      7.2%
 *
 * Between 35N and 50N — the latitudes most of Europe sits at — it is 12.2% in
 * December against 0.2% in August. The northern hemisphere is simply green in
 * August, which is what a child needs to see to tell one place from another.
 */
const SOURCE = {
  url: 'https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73776/world.topo.bathy.200408.3x5400x2700.jpg',
  file: 'blue-marble-200408-5400.jpg',
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
  console.log('\nmypassport.club texture build\n');
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
