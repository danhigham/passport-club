#!/usr/bin/env node
/**
 * Alignment check for the hybrid map.
 *
 * The satellite layer is drawn by a fragment shader; the borders and the
 * highlight over them are drawn by d3. Those are two independent
 * implementations of the same projection, and if they disagree by even a few
 * pixels the outlines visibly slide off their coastlines.
 *
 * Rather than trusting the transcription, this measures it. For a dense grid of
 * pixels it asks two questions: does the photograph look like land here, and
 * does d3 say a country polygon covers this point? Coastlines are fuzzy, so the
 * two never agree completely -- what matters is that the disagreement is
 * *minimised at zero offset*. The check nudges the comparison by a few pixels
 * in each direction and confirms the best match is dead centre.
 *
 *   node scripts/align.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { geoBounds, geoContains } from 'd3-geo';
import topojsonClient from 'topojson-client';

const { feature: topoFeature } = topojsonClient;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4383);
const ORIGIN = `http://localhost:${PORT}`;
const SHIFTS = [-4, -3, -2, -1, 0, 1, 2, 3, 4];

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = path.join(process.env.HOME ?? '', '.cache', 'ms-playwright');
  const dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium-')).sort().reverse();
  for (const d of dirs) {
    const exe = path.join(base, d, 'chrome-linux64', 'chrome');
    if (fs.existsSync(exe)) return exe;
  }
  return '/usr/bin/google-chrome';
}

const topo = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'public', 'data', 'countries.topo.json'), 'utf8'),
);
const countries = topoFeature(topo, topo.objects.countries).features;

/**
 * Bounding boxes, so the containment test can reject almost everything cheaply.
 * Without this the check is a few hundred million point-in-polygon tests and
 * never finishes.
 */
const boxes = countries.map((f) => geoBounds(f));

function onLandAt(lonLat) {
  const [lon, lat] = lonLat;
  for (let i = 0; i < countries.length; i++) {
    const [[x0, y0], [x1, y1]] = boxes[i];
    if (lat < y0 || lat > y1) continue;
    // Boxes that straddle the antimeridian come back with x0 > x1.
    const inLon = x0 <= x1 ? lon >= x0 && lon <= x1 : lon >= x0 || lon <= x1;
    if (!inLon) continue;
    if (geoContains(countries[i], lonLat)) return true;
  }
  return false;
}

// DEV=1 runs against the dev server, where React mounts effects twice. That is
// not a detail: it is where the WebGL layer was found dead on arrival.
const server = spawn(
  'npx',
  process.env.DEV === '1'
    ? ['vite', '--port', String(PORT), '--strictPort']
    : ['vite', 'preview', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: 'ignore', detached: true },
);
/**
 * Shut the preview server down on every exit path.
 *
 * `exit` alone is not enough: it does not fire when the process is killed or
 * when a harness times out, and each of those leaked a server holding its port
 * until the machine was cleaned up by hand.
 */
function stopServer() {
  if (server.killed) return;
  try { process.kill(-server.pid, 'SIGTERM'); } catch { try { server.kill('SIGTERM'); } catch {} }
}
for (const signal of ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException']) {
  process.on(signal, (err) => {
    stopServer();
    if (signal === 'uncaughtException') { console.error(err); process.exit(1); }
  });
}
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(ORIGIN)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch({ headless: true, executablePath: findChrome() });
const page = await (
  await browser.newContext({ viewport: { width: 1100, height: 860 } })
).newPage();

await page.goto(`${ORIGIN}/?e2e=1`);
await page.locator('.setup').waitFor();
await page.locator('.big-card', { hasText: 'Countries' }).first().click();
await page.locator('.chip', { hasText: 'Whole world' }).first().click();
await page.locator('.switch', { hasText: 'Use satellite photos' }).click();
// Borders would bias the colour test towards land along every coast.
await page.locator('.switch', { hasText: 'Draw country borders' }).click();
await page.locator('.start-button').click();
await page.locator('.globe-stage').waitFor();
await page.waitForFunction(() => window.__passportClub?.animating === false, null, {
  timeout: 20000,
});
await page.waitForTimeout(2500); // let the full-size texture arrive

let failures = 0;
const results = [];

/*
 * Before measuring alignment, check there is anything to align against.
 *
 * In satellite mode the vector layer deliberately stops painting land, leaving
 * the photograph to supply it. If the photograph never arrives, the result is a
 * bare blue sphere with borders floating on it -- which sails through an
 * alignment test, because the borders are in exactly the right place. That is
 * precisely what a dead WebGL context produced, so it needs its own check.
 */
{
  const hues = await page.evaluate(() => {
    const src = document.querySelector('canvas.globe-canvas');
    const off = document.createElement('canvas');
    off.width = 160;
    off.height = 120;
    const octx = off.getContext('2d', { willReadFrequently: true });
    octx.drawImage(src, 0, 0, 160, 120);
    const d = octx.getImageData(0, 0, 160, 120).data;
    let earthy = 0;
    let cream = 0;
    let total = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      if (r < 12 && g < 25 && b < 45) continue; // space
      total++;
      // The painted globe fills land with one flat cream, #f2e3c4. Finding it
      // here means the vector base map is on screen, whatever was asked for.
      const isCream =
        Math.abs(r - 242) < 14 && Math.abs(g - 227) < 14 && Math.abs(b - 196) < 14;
      if (isCream) cream++;
      // Greens and browns, which only a photograph produces.
      else if (g > b + 10) earthy++;
    }
    return { earthy, cream, total };
  });
  const share = hues.total ? hues.earthy / hues.total : 0;
  const creamShare = hues.total ? hues.cream / hues.total : 0;
  // Both halves matter: the photograph must be there, and the painted globe
  // must not be. Checking only the first passes when satellite silently falls
  // back to vector, which looks fine but is not what was asked for.
  const painted = share > 0.05 && creamShare < 0.02;
  if (!painted) failures++;
  results.push(
    `${painted ? 'PASS' : 'FAIL'}  ${'photograph rendered'.padEnd(18)} ` +
      `${(share * 100).toFixed(1)}% photographic land, ${(creamShare * 100).toFixed(1)}% painted land`,
  );
}

for (const [label, centre, zoom] of [
  ['Europe / Africa', [10, 20], 1],
  ['the Americas', [-70, 10], 1.6],
  ['Asia / Australia', [110, 0], 1.6],
]) {
  // One call: setting centre and zoom separately made the second overwrite the
  // first with a stale value, and every scenario silently tested the same view.
  await page.evaluate(
    ([c, z]) => window.__passportClub.setCamera(c, z),
    [centre, zoom],
  );
  await page.waitForTimeout(600);

  const camera = await page.evaluate(() => window.__passportClub.camera);

  // Grab the pixels once, then do all the geometry in Node.
  const grab = await page.evaluate(() => {
    const src = document.querySelector('canvas.globe-canvas');
    const off = document.createElement('canvas');
    off.width = src.width;
    off.height = src.height;
    const octx = off.getContext('2d', { willReadFrequently: true });
    octx.drawImage(src, 0, 0);
    const rect = src.getBoundingClientRect();
    const dpr = src.width / rect.width;
    const data = octx.getImageData(0, 0, src.width, src.height);
    return {
      dpr,
      w: src.width,
      h: src.height,
      cssW: rect.width,
      cssH: rect.height,
      pixels: Array.from(data.data),
    };
  });

  const { dpr, w, pixels, cssW, cssH } = grab;
  // Ocean in Blue Marble is markedly blue; land is green, brown or white.
  const looksOcean = (px, py) => {
    const i = ((py * w + px) * 4) | 0;
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const a = pixels[i + 3];
    if (a < 200) return null; // off the globe
    return b > r + 18 && b > g + 8;
  };

  // Walk a grid of css pixels; ask the page to invert them in one batch.
  const samples = [];
  for (let y = 20; y < cssH - 20; y += 7) {
    for (let x = 20; x < cssW - 20; x += 7) samples.push([x, y]);
  }
  const lonLats = await page.evaluate((pts) => {
    const api = window.__passportClub;
    return pts.map((p) => api.unproject(p[0], p[1]));
  }, samples);

  // Whether a sample is on land depends only on its coordinates, not on the
  // pixel offset being trialled, so it is resolved once per sample rather than
  // once per sample per offset.
  const land = lonLats.map((ll) => (ll ? onLandAt(ll) : null));

  const best = { score: Infinity, dx: null, dy: null };
  const scoreFor = (dx, dy) => {
    let disagree = 0;
    let counted = 0;
    for (let i = 0; i < samples.length; i++) {
      if (land[i] === null) continue;
      const [x, y] = samples[i];
      const px = Math.round((x + dx) * dpr);
      const py = Math.round((y + dy) * dpr);
      if (px < 0 || py < 0 || px >= w || py >= grab.h) continue;
      const ocean = looksOcean(px, py);
      if (ocean === null) continue;
      counted++;
      if (land[i] === ocean) disagree++;
    }
    return counted ? disagree / counted : Infinity;
  };

  for (const dy of SHIFTS) {
    for (const dx of SHIFTS) {
      const score = scoreFor(dx, dy);
      if (score < best.score) {
        best.score = score;
        best.dx = dx;
        best.dy = dy;
      }
    }
  }

  /*
   * Allow a single pixel of slack. The photograph is resampled by the shader
   * and the polygons are rasterised by the canvas, so coastal pixels disagree
   * at the sub-pixel level no matter how well the projections match; what a
   * real misalignment looks like is an offset of several pixels, and a centre
   * score clearly worse than the best. Both are tested.
   */
  const zero = scoreFor(0, 0);
  const centred = Math.abs(best.dx) <= 1 && Math.abs(best.dy) <= 1;
  const noBetter = zero - best.score < 0.005;
  const ok = centred && noBetter;
  if (!ok) failures++;
  results.push(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(18)} best offset (${best.dx}, ${best.dy})px, ` +
      `mismatch ${(best.score * 100).toFixed(1)}% vs ${(zero * 100).toFixed(1)}% centred ` +
      `[camera ${camera.center.map((n) => n.toFixed(0)).join(',')} zoom ${camera.zoom.toFixed(2)}]`,
  );
}

console.log('\n' + results.join('\n'));
console.log(
  failures
    ? `\n${failures} alignment check(s) failed: the shader and d3 disagree.\n`
    : '\nShader and d3 agree to the pixel.\n',
);

await browser.close();
stopServer();
process.exit(failures ? 1 : 0);
