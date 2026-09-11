#!/usr/bin/env node
/**
 * Rendering benchmark.
 *
 * Spins the globe under a scripted drag and reports how long frames take to
 * paint. Every frame of a spin re-projects the world from scratch, so this is
 * the number that decides whether a vector globe is viable at all.
 *
 *   node scripts/bench.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4341, ORIGIN = `http://localhost:${PORT}`;

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

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: 'ignore', detached: true });
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
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(ORIGIN)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch({ headless: true, executablePath: findChrome() });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

async function start(mode, scope, satellite = false) {
  await page.goto(`${ORIGIN}/?e2e=1`);
  await page.locator('.setup').waitFor();
  await page.locator('.big-card', { hasText: mode }).first().click();
  if (scope) await page.locator(scope.sel, { hasText: scope.text }).first().click();
  if (satellite) await page.locator('.chip', { hasText: 'Satellite photos' }).click();
  await page.locator('.start-button').click();
  await page.locator('.globe-stage').waitFor();
  await page.waitForFunction(() => window.__passportClub?.camera != null);
  await page.waitForFunction(() => window.__passportClub?.animating === false, null, { timeout: 20000 });
  await page.waitForTimeout(300);
}

/** Drag in a circle so the whole globe passes through view. */
async function spin(ms) {
  const box = await page.locator('.globe-stage').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.evaluate(() => window.__passportClub.resetRenderStats());
  const rafs = await page.evaluateHandle(() => {
    const s = { n: 0, stop: false };
    const tick = () => { s.n++; if (!s.stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    window.__bench = s;
    return s;
  });
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < ms) {
    i++;
    await page.mouse.move(cx + Math.sin(i / 6) * 260, cy + Math.cos(i / 9) * 90);
  }
  await page.mouse.up();
  const elapsed = Date.now() - t0;
  const frames = await page.evaluate(() => { window.__bench.stop = true; return window.__bench.n; });
  await rafs.dispose();
  const stats = await page.evaluate(() => window.__passportClub.renderStats());
  return { stats, fps: +(frames / (elapsed / 1000)).toFixed(1), moves: i };
}

/** Sweep the pointer without dragging: this is hit-testing plus repaint. */
async function hover(ms) {
  const box = await page.locator('.globe-stage').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.evaluate(() => window.__passportClub.resetRenderStats());
  const t0 = Date.now();
  let moves = 0;
  while (Date.now() - t0 < ms) {
    moves++;
    await page.mouse.move(cx + Math.sin(moves / 5) * 240, cy + Math.cos(moves / 7) * 160);
  }
  return { moves, perSecond: +(moves / ((Date.now() - t0) / 1000)).toFixed(1) };
}

const scenarios = [
  ['Countries, world',    () => start('Countries', { sel: '.chip', text: 'Whole world' })],
  ['Countries, Europe',   () => start('Countries', { sel: '.chip', text: 'Europe' })],
  ['Continents (tinted)', () => start('Continents', null)],
  ['Counties, UK',        () => start('States & Counties', { sel: '.chip.tall', text: 'United Kingdom' })],
  ['States, USA',         () => start('States & Counties', { sel: '.chip.tall', text: 'United States' })],
  ['Satellite, world',    async () => { await start('Countries', { sel: '.chip', text: 'Whole world' }, true); await page.waitForTimeout(2500); }],
  ['Satellite, Europe',   async () => { await start('Countries', { sel: '.chip', text: 'Europe' }, true); await page.waitForTimeout(2500); }],
];

console.log('\nscenario                 paint mean   p50    p95    max     fps');
console.log('-'.repeat(66));
for (const [name, go] of scenarios) {
  await go();
  const { stats, fps } = await spin(2500);
  console.log(
    `${name.padEnd(24)} ${String(stats.mean).padStart(7)}ms ${String(stats.p50).padStart(6)} ` +
    `${String(stats.p95).padStart(6)} ${String(stats.max).padStart(6)} ${String(fps).padStart(7)}`,
  );
}
console.log('\nhover (hit-test + repaint), moves processed per second');
console.log('-'.repeat(66));
for (const [name, go] of [scenarios[0], scenarios[4]]) {
  await go();
  const h = await hover(2000);
  console.log(`${name.padEnd(24)} ${String(h.perSecond).padStart(7)} moves/sec`);
}
console.log();
await browser.close();
stopServer();
