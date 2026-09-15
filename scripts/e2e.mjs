#!/usr/bin/env node
/**
 * Browser test: actually plays the game.
 *
 * Builds the app, serves it, then for each mode drives a real Chromium through
 * a full round — reading each question off the screen, projecting the answer's
 * real-world coordinates to a pixel position, and clicking there. It asserts
 * the game accepts correct clicks, rejects wrong ones, and reaches the results
 * screen with the score it should have.
 *
 *   node scripts/e2e.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4317;
const ORIGIN = `http://localhost:${PORT}`;

/* Playwright's bundled revision may not be the one on this machine. */
function findChrome() {
  const base = path.join(process.env.HOME ?? '', '.cache', 'ms-playwright');
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (fs.existsSync(base)) {
    const dirs = fs
      .readdirSync(base)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .reverse();
    for (const d of dirs) {
      const exe = path.join(base, d, 'chrome-linux64', 'chrome');
      if (fs.existsSync(exe)) return exe;
    }
  }
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/chromium']) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('No Chromium found. Set CHROME_PATH.');
}

/* ---------------------------------------------------------------- server */

// DEV=1 runs against the dev server. React double-invokes state updaters there
// on purpose, which is how a ten-question game came to record twenty answers.
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

async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(ORIGIN);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Preview server never came up');
}

/* ----------------------------------------------------------------- suite */

let failures = 0;
const lines = [];
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
};

const handle = (page) => page.evaluate(() => window.__passportClub ?? null);

/** Click the globe at a screen position relative to the stage. */
async function clickMap(page, [x, y]) {
  const box = await page.locator('.globe-stage').boundingBox();
  await page.mouse.click(box.x + x, box.y + y);
}

/**
 * Click a real-world coordinate.
 *
 * On a globe a place can be round the back, where it has no screen position at
 * all, so turn the planet to face it first — exactly what a player does by
 * dragging.
 */
/**
 * How far from the centre of the view a click is allowed to be, as a fraction
 * of the half-viewport. Beyond this the globe is turned first.
 *
 * Measured on screen rather than in degrees, because the two are not
 * interchangeable: on a sphere the angle covered by a pixel grows without bound
 * towards the limb, and how close the limb *is* depends on the zoom. At the
 * world view the horizon is 90 degrees away; zoomed to 2.5x it is barely 23.
 * A fixed angular threshold is therefore right at one zoom and wrong at every
 * other, whereas "reasonably central on screen" holds at all of them.
 */
const CENTRAL_FRACTION = 0.6;

async function clickPlace(page, lonLat) {
  // A fresh round ignores input briefly, so a mistimed tap can't be spent on
  // it. A human is always past that by the time they've read the question; the
  // test is not, so wait for the same thing they would.
  await page.waitForFunction(
    () => window.__passportClub?.armed?.() === true && window.__passportClub.animating === false,
    null,
    { timeout: 8000 },
  );
  const box = await page.locator('.globe-stage').boundingBox();
  const limit = (CENTRAL_FRACTION * Math.min(box.width, box.height)) / 2;
  const isCentral = (p) =>
    p && Math.hypot(p[0] - box.width / 2, p[1] - box.height / 2) <= limit;

  // Turn the globe if the target is round the back, or out where a pixel covers
  // too much ground to click precisely. A real player does exactly this.
  let xy = await page.evaluate((pt) => window.__passportClub.project(pt), lonLat);
  if (!isCentral(xy)) {
    await page.evaluate((pt) => window.__passportClub.faceTo(pt), lonLat);
    await page.waitForTimeout(150);
    xy = await page.evaluate((pt) => window.__passportClub.project(pt), lonLat);
  }
  if (!xy) return false;
  await clickMap(page, xy);
  return true;
}

/** Drag across the globe, as a finger or mouse would. */
async function dragGlobe(page, dx, dy) {
  const box = await page.locator('.globe-stage').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(cx + (dx * i) / 10, cy + (dy * i) / 10);
  }
  await page.mouse.up();
}

/** Read the question currently on screen. */
async function currentPrompt(page) {
  return {
    name: await page.locator('.prompt-name').textContent(),
    sub: await page.locator('.prompt-sub').textContent().catch(() => null),
    round: await page.locator('.stat', { hasText: 'Round' }).locator('.stat-value').textContent(),
    score: await page.locator('.stat', { hasText: 'Score' }).locator('.stat-value').textContent(),
  };
}

async function startGame(page, { mode, scopeLabel, level, rounds }) {
  await page.goto(`${ORIGIN}/?e2e=1`);
  await page.locator('.setup').waitFor({ timeout: 20000 });

  await page.locator('.big-card', { hasText: mode }).first().click();
  if (scopeLabel) {
    await page.locator('.chip', { hasText: scopeLabel }).first().click();
  }
  if (level) {
    await page.locator('.big-card', { hasText: level }).first().click();
  }
  if (rounds) {
    // Scoped to the question-count row: there are now two rows of small chips
    // on the setup screen, and an unscoped match hits both.
    await page
      .locator('.rounds-row', { hasText: 'questions' })
      .locator('.chip.small', { hasText: new RegExp(`^${rounds}$`) })
      .click();
  }
  await page.locator('.start-button').click();
  await page.locator('.globe-stage').waitFor({ timeout: 30000 });
  await page.locator('.prompt-name').waitFor({ timeout: 15000 });
  // Wait for the globe to have a camera and to have finished its opening
  // flight before asking it to project anything.
  await page.waitForFunction(() => window.__passportClub?.camera != null);
  await page.waitForFunction(() => window.__passportClub?.animating === false, null, {
    timeout: 8000,
  });
}

/* ------------------------------------------------------------------ main */

await waitForServer();
const browser = await chromium.launch({ headless: true, executablePath: findChrome() });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

try {
  /* --- 1. every mode is playable, and correct clicks are accepted --- */

  const modes = [
    { label: 'Continents', mode: 'Continents', rounds: null, expect: 7 },
    { label: 'Countries (Europe)', mode: 'Countries', scopeLabel: 'Europe', level: 'Explorer', rounds: 5 },
    { label: 'States & Counties (USA)', mode: 'States & Counties', level: 'Explorer', rounds: 5 },
    { label: 'Cities (world)', mode: 'Cities', scopeLabel: 'Whole world', level: 'Explorer', rounds: 5 },
  ];

  for (const m of modes) {
    await startGame(page, m);

    const seen = [];
    let solved = 0;
    for (let i = 0; i < (m.expect ?? m.rounds); i++) {
      const h = await handle(page);
      if (!h?.target) break;
      const prompt = await currentPrompt(page);
      seen.push(prompt.name);

      if (!(await clickPlace(page, h.target.point))) break;

      // A correct answer swaps the dock into its "correct" state.
      await page
        .locator('.prompt-dock.status-correct')
        .waitFor({ timeout: 4000 })
        .then(() => solved++)
        .catch(() => {});
      await page.waitForTimeout(1700); // auto-advance
    }

    const total = m.expect ?? m.rounds;
    check(
      `${m.label.padEnd(24)} all ${total} answers accepted`,
      solved === total,
      solved === total ? '' : `solved ${solved}/${total}; saw: ${seen.join(', ')}`,
    );
    check(
      `${m.label.padEnd(24)} questions are all different`,
      new Set(seen).size === seen.length,
      seen.join(', '),
    );
  }

  /* --- 2. results screen appears with the right tally --- */
  await page.locator('.results').waitFor({ timeout: 8000 });
  const found = await page.locator('.figure', { hasText: 'found' }).locator('.figure-value').textContent();
  check('reaches the results screen with a full score', found === '5/5', `found = ${found}`);

  /* --- 3. a wrong click is rejected, explained, and costs a life --- */
  await startGame(page, { mode: 'Countries', scopeLabel: 'Whole world', level: 'Explorer', rounds: 5 });
  {
    const h = await handle(page);
    // Aim at the antipode: guaranteed wrong, wherever the answer is.
    const anti = [((h.target.point[0] + 360) % 360) - 180, -h.target.point[1]];
    await clickPlace(page, anti);
    await page.locator('.feedback.bad').waitFor({ timeout: 4000 });
    const msg = await page.locator('.feedback.bad').textContent();
    const pipsLeft = await page.locator('.pip.full').count();
    check('a wrong guess is rejected with an explanation', msg.length > 8, msg);
    check('a wrong guess costs one of three lives', pipsLeft === 2, `${pipsLeft} pips left`);
    check('a miss is marked on the map', (await page.locator('.miss-mark').count()) >= 1);
  }

  /* --- 4. three misses reveals the answer --- */
  {
    const h = await handle(page);
    const anti = [((h.target.point[0] + 360) % 360) - 180, -h.target.point[1]];
    for (let i = 0; i < 2; i++) {
      await clickPlace(page, anti);
      await page.waitForTimeout(400);
    }
    await page.locator('.prompt-dock.status-revealed').waitFor({ timeout: 5000 });
    check('three misses reveals the answer', true);

    // The pin cannot appear until the globe has turned far enough to bring the
    // answer into view, so wait for the flight rather than racing it.
    const pinned = await page
      .locator('.answer-pin')
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    check('the reveal pins the answer on the map', pinned);
  }

  /* --- 5. the helper toggles reach the map --- */
  await startGame(page, { mode: 'Countries', scopeLabel: 'Whole world', level: 'Explorer', rounds: 5 });
  check('the globe renders to a canvas', (await page.locator('canvas.globe-canvas').count()) === 1);

  await page.goto(`${ORIGIN}/?e2e=1`);
  await page.locator('.setup').waitFor();
  await page.locator('.switch', { hasText: 'Draw country borders' }).click();
  await page.locator('.switch', { hasText: 'Show place names' }).click();
  await page.locator('.start-button').click();
  await page.locator('.globe-stage').waitFor();
  await page.waitForFunction(() => window.__passportClub?.camera != null);
  await page.waitForTimeout(500);
  check('place-name labels appear when asked for',
    (await page.locator('.place-label').count()) > 5,
    `${await page.locator('.place-label').count()} labels`);

  /* --- 6. the hint circle is created, off-centre, and turned towards --- */
  {
    await startGame(page, { mode: 'Countries', scopeLabel: 'Whole world', level: 'Explorer', rounds: 5 });
    const before = await handle(page);
    await page.locator('.ghost-button', { hasText: 'Hint' }).click();
    // Wait for the flight to finish rather than guessing at its duration. A
    // fixed pause left only a few hundred milliseconds of slack over the
    // animation, which is not enough when several browsers are competing for a
    // software renderer, and the check failed intermittently.
    await page.waitForFunction(() => window.__passportClub?.hint != null, null, {
      timeout: 8000,
    });
    await page.waitForFunction(() => window.__passportClub?.animating === false, null, {
      timeout: 8000,
    });
    await page.waitForTimeout(150);
    const after = await handle(page);

    check('the hint produces a search area', after.hint != null);
    if (after.hint) {
      // The circle must not be centred on the answer, or it would give it away.
      const off = Math.hypot(
        after.hint.center[0] - before.target.point[0],
        after.hint.center[1] - before.target.point[1],
      );
      check('the hint circle is offset from the answer', off > 0.5, `offset ${off.toFixed(2)} deg`);
      // ... and the globe must turn to show it, or it is no help at all.
      const facing = Math.hypot(
        after.camera.center[0] - after.hint.center[0],
        after.camera.center[1] - after.hint.center[1],
      );
      check('the globe turns to show the hint', facing < 5,
        `camera ${after.camera.center.map((n) => n.toFixed(1))} vs hint ${after.hint.center.map((n) => n.toFixed(1))}`);
    }
  }

  /* --- 7. zoom controls work and don't break clicking --- */
  {
    await startGame(page, { mode: 'Countries', scopeLabel: 'Europe', level: 'Explorer', rounds: 5 });
    await page.locator('.map-controls button[aria-label="Zoom in"]').click();
    await page.locator('.map-controls button[aria-label="Zoom in"]').click();
    await page.waitForTimeout(400);
    const h = await handle(page);
    const clicked = await clickPlace(page, h.target.point);
    const accepted =
      clicked &&
      (await page
        .locator('.prompt-dock.status-correct')
        .waitFor({ timeout: 4000 })
        .then(() => true)
        .catch(() => false));
    check('clicks still land correctly after zooming', accepted);
  }

  /* --- 8. the globe actually spins, and stays the right way up --- */
  {
    await startGame(page, { mode: 'Countries', scopeLabel: 'Whole world', level: 'Explorer', rounds: 5 });
    const before = (await handle(page)).camera;
    await dragGlobe(page, 260, 0);
    await page.waitForTimeout(200);
    const after = (await handle(page)).camera;

    const lonMoved = Math.abs(after.center[0] - before.center[0]) > 10;
    check('dragging sideways spins the globe', lonMoved,
      `${before.center[0].toFixed(1)} -> ${after.center[0].toFixed(1)}`);
    check('a sideways drag does not tilt the poles',
      Math.abs(after.center[1] - before.center[1]) < 1,
      `lat ${before.center[1].toFixed(1)} -> ${after.center[1].toFixed(1)}`);

    // Dragging far past the pole must stop at it rather than flipping over.
    await dragGlobe(page, 0, -1200);
    await dragGlobe(page, 0, -1200);
    const polar = (await handle(page)).camera;
    check('the globe cannot be flipped upside-down',
      polar.center[1] <= 90 && polar.center[1] >= -90,
      `lat ${polar.center[1].toFixed(1)}`);

    // A spin must not have knocked the guessing logic out of alignment.
    const h = await handle(page);
    const ok = await clickPlace(page, h.target.point);
    const accepted = ok && (await page.locator('.prompt-dock.status-correct')
      .waitFor({ timeout: 4000 }).then(() => true).catch(() => false));
    check('clicks land correctly after spinning', accepted);
  }

  /* --- 9. zoom controls change the camera --- */
  {
    await startGame(page, { mode: 'Countries', scopeLabel: 'Whole world', level: 'Explorer', rounds: 5 });
    const z0 = (await handle(page)).camera.zoom;
    await page.locator('.map-controls button[aria-label="Zoom in"]').click();
    await page.waitForTimeout(250);
    const z1 = (await handle(page)).camera.zoom;
    check('the zoom button moves the camera closer', z1 > z0 * 1.2, `${z0} -> ${z1}`);
    await page.locator('.map-controls button[aria-label="Reset the view"]').click();
    await page.waitForTimeout(800);
    const z2 = (await handle(page)).camera.zoom;
    check('reset returns to the starting view', Math.abs(z2 - z0) < 0.05, `${z2} vs ${z0}`);
  }

  /* --- 10. a scoped round starts framed on its region --- */
  {
    await startGame(page, { mode: 'Countries', scopeLabel: 'Europe', level: 'Explorer', rounds: 5 });
    const cam = (await handle(page)).camera;
    check('a Europe round opens looking at Europe',
      cam.zoom > 1.4 && cam.center[1] > 20 && cam.center[0] > -20 && cam.center[0] < 50,
      `center ${cam.center.map((n) => n.toFixed(1)).join(', ')} zoom ${cam.zoom.toFixed(2)}`);
  }

  /* --- 11. a correct answer must not offer a button that vanishes --- */
  {
    await startGame(page, { mode: 'Continents', rounds: null, expect: 7 });
    const h = await handle(page);
    await clickPlace(page, h.target.point);
    await page.locator('.prompt-dock.status-correct').waitFor({ timeout: 4000 });

    // The round is about to advance on its own. Anything clickable here is a
    // target that disappears mid-reach, handing the press to whatever replaces
    // it — which used to be "Show me", instantly revealing the next answer.
    const buttons = await page.locator('.prompt-card button').count();
    check('a correct answer shows no button while it auto-advances', buttons === 0,
      `${buttons} button(s) in the prompt card`);
    check('a correct answer shows its progress instead',
      (await page.locator('.advancing .advance-fill').count()) === 1);

    // And the reproduction: aim where the old button was, press as the round
    // turns over, and confirm the new question is untouched.
    const box = await page.locator('.prompt-card').boundingBox();
    const aim = { x: box.x + box.width - 70, y: box.y + box.height / 2 };
    await page.waitForTimeout(1400); // land the click right on the changeover
    await page.mouse.click(aim.x, aim.y);
    await page.waitForTimeout(500);

    const after = await handle(page);
    check('a mistimed press cannot skip or reveal the next question',
      after.status === 'guessing' && after.guesses.length === 0,
      `status ${after.status}, ${after.guesses.length} guess(es)`);
  }

  /* --- 12. a wrong answer still waits for the player --- */
  {
    await startGame(page, { mode: 'Countries', scopeLabel: 'Whole world', level: 'Explorer', rounds: 5 });
    const h = await handle(page);
    const anti = [((h.target.point[0] + 360) % 360) - 180, -h.target.point[1]];
    for (let i = 0; i < 3; i++) {
      await clickPlace(page, anti);
      await page.waitForTimeout(350);
    }
    await page.locator('.prompt-dock.status-revealed').waitFor({ timeout: 5000 });
    await page.waitForTimeout(2500); // longer than the auto-advance delay

    check('a revealed answer waits rather than advancing itself',
      (await page.locator('.prompt-dock.status-revealed').count()) === 1);
    check('a revealed answer keeps its Next button',
      (await page.locator('.next-button').count()) === 1);

    await page.locator('.next-button').click();
    await page.waitForTimeout(400);
    check('Next moves on when the player is ready',
      (await handle(page)).status === 'guessing');
  }

  /* --- 13. the view travels between questions instead of teleporting --- */
  {
    await startGame(page, { mode: 'Countries', scopeLabel: 'Whole world', level: 'Explorer', rounds: 5 });

    // Record the round's home view *before* moving, since that is where the
    // next question is supposed to bring us back to.
    const home = (await handle(page)).camera;

    // Now zoom somewhere the next round has to travel back from.
    await page.locator('.map-controls button[aria-label="Zoom in"]').click();
    await page.locator('.map-controls button[aria-label="Zoom in"]').click();
    await page.waitForTimeout(400);
    const zoomed = (await handle(page)).camera;

    const h = await handle(page);
    await clickPlace(page, h.target.point);
    await page.locator('.prompt-dock.status-correct').waitFor({ timeout: 4000 });

    // The round auto-advances; catch the globe mid-flight.
    await page.waitForFunction(() => window.__passportClub?.animating === true, null,
      { timeout: 5000 });
    check('the view animates between questions rather than snapping', true);

    // Guessing while the globe is still moving would be aiming at a sliding
    // target, so those taps must not cost the player a life.
    const box = await page.locator('.globe-stage').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await page.waitForFunction(() => window.__passportClub?.animating === false, null,
      { timeout: 8000 });
    const settled = await handle(page);
    check('no guess is spent while the view is in motion',
      settled.guesses.length === 0, `${settled.guesses.length} guess(es)`);
    // The centre travels home, because the next answer could be anywhere and
    // being left pointed at the last one is disorienting.
    check('the next question re-centres on the round\u2019s home view',
      Math.abs(settled.camera.center[1] - home.center[1]) < 3,
      `ended at ${settled.camera.center.map((n) => n.toFixed(1))}, home is ${home.center.map((n) => n.toFixed(1))}`);

    // The zoom does not, because the player chose it. Resetting it every
    // question means re-zooming ten times a game.
    check('the player\u2019s zoom survives the question change',
      Math.abs(settled.camera.zoom - zoomed.zoom) < 0.25,
      `zoomed to ${zoomed.zoom.toFixed(2)}, next question opened at ` +
        `${settled.camera.zoom.toFixed(2)} (home is ${home.zoom.toFixed(2)})`);

    // ... but the home button still means "put it back", zoom included.
    await page.locator('.map-controls button[aria-label="Reset the view"]').click();
    await page.waitForTimeout(900);
    const afterReset = (await handle(page)).camera;
    check('the home button restores the original zoom',
      Math.abs(afterReset.zoom - home.zoom) < 0.1,
      `${afterReset.zoom.toFixed(2)} vs home ${home.zoom.toFixed(2)}`);

    // And a new game must not inherit the last one's magnification.
    await page.locator('.map-controls button[aria-label="Zoom in"]').click();
    await page.locator('.map-controls button[aria-label="Zoom in"]').click();
    await page.waitForTimeout(300);
    await startGame(page, { mode: 'Countries', scopeLabel: 'Whole world', level: 'Explorer', rounds: 5 });
    const fresh = (await handle(page)).camera;
    check('a new game starts from its own framing, not the last zoom',
      Math.abs(fresh.zoom - home.zoom) < 0.25,
      `new game opened at ${fresh.zoom.toFixed(2)}, home is ${home.zoom.toFixed(2)}`);
  }

  /* --- 14. a scoped game opens by flying in from the whole planet --- */
  {
    await page.goto(`${ORIGIN}/?e2e=1`);
    await page.locator('.setup').waitFor();
    await page.locator('.big-card', { hasText: 'Countries' }).first().click();
    await page.locator('.chip', { hasText: 'Europe' }).first().click();
    await page.locator('.start-button').click();
    await page.locator('.globe-stage').waitFor();
    await page.waitForFunction(() => window.__passportClub?.camera != null);

    const opening = await handle(page);
    check('a scoped game opens on the whole planet and flies in',
      opening.animating === true && opening.camera.zoom < 1.5,
      `zoom ${opening.camera.zoom.toFixed(2)}, animating ${opening.animating}`);

    await page.waitForFunction(() => window.__passportClub?.animating === false, null,
      { timeout: 8000 });
    const arrived = await handle(page);
    check('the opening flight arrives at the scope',
      arrived.camera.zoom > 1.8 && arrived.camera.center[1] > 30,
      `center ${arrived.camera.center.map((n) => n.toFixed(1))} z${arrived.camera.zoom.toFixed(2)}`);
  }

  /* --- 15. empty space is not a guess --- */
  {
    await startGame(page, { mode: 'Countries', scopeLabel: 'Whole world', level: 'Explorer', rounds: 5 });
    const box = await page.locator('.globe-stage').boundingBox();

    // The corners of a world view are sky, not planet. Clicking them used to
    // cost a life each, because d3's invert clamps to the limb instead of
    // reporting that the point missed the globe entirely.
    const corners = [
      [10, 10],
      [box.width - 10, 10],
      [10, box.height - 10],
      [box.width - 10, box.height - 10],
    ];
    for (const [cx, cy] of corners) {
      await page.mouse.click(box.x + cx, box.y + cy);
      await page.waitForTimeout(120);
    }

    const h = await handle(page);
    check('clicking empty space costs nothing',
      h.guesses.length === 0 && h.status === 'guessing',
      `${h.guesses.length} guess(es), status ${h.status}`);
    check('clicking empty space leaves all three lives',
      (await page.locator('.pip.full').count()) === 3);
    check('clicking empty space marks nothing on the map',
      (await page.locator('.miss-mark').count()) === 0);

    // ... but the planet itself still registers.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);
    check('the globe itself still registers clicks',
      (await handle(page)).guesses.length === 1);
  }

  /* --- 16. the reveal ring pulses in place --- */
  {
    await startGame(page, { mode: 'Continents', rounds: null, expect: 7 });
    const h = await handle(page);
    await clickPlace(page, h.target.point);
    await page.locator('.answer-pin').waitFor({ timeout: 5000 });

    const box = await page.evaluate(() => {
      const el = document.querySelector('.answer-pin .pulse');
      const cs = getComputedStyle(el);
      return { transformBox: cs.transformBox };
    });
    check('the pulse ring is scoped to its own box', box.transformBox === 'fill-box',
      `transform-box: ${box.transformBox}`);

    // The real check: sample the ring's centre across the animation. It scales,
    // so the size changes -- but if the origin is wrong it also travels, which
    // is what made a circle fly diagonally across the screen.
    const sample = () =>
      page.evaluate(() => {
        const r = document.querySelector('.answer-pin .pulse').getBoundingClientRect();
        return [r.x + r.width / 2, r.y + r.height / 2];
      });
    const a = await sample();
    await page.waitForTimeout(260);
    const b2 = await sample();
    await page.waitForTimeout(260);
    const c = await sample();
    const drift = Math.max(
      Math.hypot(b2[0] - a[0], b2[1] - a[1]),
      Math.hypot(c[0] - a[0], c[1] - a[1]),
    );
    check('the pulse ring stays put instead of flying across the screen', drift < 3,
      `centre drifted ${drift.toFixed(1)}px`);
  }

  /* --- 17. the region hint can be turned off --- */
  {
    await startGame(page, { mode: 'Countries', scopeLabel: 'Whole world', level: 'Explorer', rounds: 5 });
    check('the region hint is shown by default',
      (await page.locator('.prompt-sub').count()) === 1);
    const shown = await page.locator('.prompt-sub').textContent();

    await page.goto(`${ORIGIN}/?e2e=1`);
    await page.locator('.setup').waitFor();
    await page.locator('.switch', { hasText: "Say which part of the world it's in" }).click();
    await page.locator('.start-button').click();
    await page.locator('.globe-stage').waitFor();
    await page.waitForFunction(() => window.__passportClub?.camera != null);
    await page.locator('.prompt-name').waitFor();

    check('turning the region hint off removes it',
      (await page.locator('.prompt-sub').count()) === 0,
      `was showing \"${shown}\"`);
    check('the question itself is still there',
      ((await page.locator('.prompt-name').textContent()) ?? '').length > 1);
  }

  /* --- 18. the number of tries is configurable --- */
  const setTries = async (n) => {
    await page.goto(`${ORIGIN}/?e2e=1`);
    await page.locator('.setup').waitFor();
    await page.locator('.big-card', { hasText: 'Countries' }).first().click();
    await page.locator('.chip', { hasText: 'Whole world' }).first().click();
    await page
      .locator('.rounds-row', { hasText: 'tries' })
      .locator('.chip.small', { hasText: new RegExp(`^${n}$`) })
      .click();
    await page.locator('.start-button').click();
    await page.locator('.globe-stage').waitFor();
    await page.waitForFunction(
      () => window.__passportClub?.armed?.() === true && window.__passportClub.animating === false,
      null,
      { timeout: 8000 },
    );
  };
  const missOnce = async () => {
    const h = await handle(page);
    const anti = [((h.target.point[0] + 360) % 360) - 180, -h.target.point[1]];
    await clickPlace(page, anti);
    await page.waitForTimeout(350);
  };

  {
    await setTries(1);
    check('one try shows a single life', (await page.locator('.pip').count()) === 1);
    await missOnce();
    check('with one try, a single miss reveals the answer',
      (await page.locator('.prompt-dock.status-revealed').count()) === 1);
  }
  {
    await setTries(5);
    check('five tries shows five lives', (await page.locator('.pip').count()) === 5);
    for (let i = 0; i < 4; i++) await missOnce();
    const stillGoing = (await handle(page)).status === 'guessing';
    check('with five tries, four misses do not reveal it', stillGoing,
      `status ${(await handle(page)).status}`);
    await missOnce();
    check('the fifth miss reveals it',
      (await page.locator('.prompt-dock.status-revealed').count()) === 1);
  }

  /* --- 19. a game of N questions records exactly N answers --- */
  {
    // Stated explicitly rather than inherited: the setup screen remembers the
    // last game, so an assumed question count is an assumption about whatever
    // ran before this.
    const ROUNDS = 5;
    await startGame(page, { mode: 'Continents', rounds: ROUNDS });

    const played = [];
    for (let i = 0; i < ROUNDS; i++) {
      const h = await handle(page);
      if (!h?.target) break;
      played.push(h.target.name);
      await clickPlace(page, h.target.point);
      await page.waitForTimeout(1900); // answer, celebrate, auto-advance
    }

    check('every question was played once', played.length === ROUNDS,
      `played ${played.length}: ${played.join(', ')}`);

    await page.locator('.results').waitFor({ timeout: 8000 });
    const listed = await page.locator('.review li').count();
    const names = await page.locator('.review-name').allTextContents();
    const found = await page
      .locator('.figure', { hasText: 'found' })
      .locator('.figure-value')
      .textContent();

    check('the results list one entry per question', listed === ROUNDS,
      `${listed} entries for ${ROUNDS} questions`);
    check('no question is listed twice',
      new Set(played).size === played.length && listed === ROUNDS,
      names.join(' | '));
    check('the tally matches the number of questions', found === `${ROUNDS}/${ROUNDS}`,
      `tally ${found}`);
  }

  /* --- 20. continent mode settles on Explorer by itself --- */
  {
    await page.goto(`${ORIGIN}/?e2e=1`);
    await page.locator('.setup').waitFor();

    // Pick a level that continent mode cannot use, then switch to it.
    await page.locator('.big-card', { hasText: 'Countries' }).first().click();
    await page.locator('.big-card', { hasText: 'Globetrotter' }).click();
    const selected = () =>
      page.locator('.big-card.selected .card-title').allTextContents();
    check('a harder level can be chosen outside continent mode',
      (await selected()).includes('Globetrotter'), (await selected()).join(', '));

    await page.locator('.big-card', { hasText: 'Continents' }).first().click();
    await page.waitForTimeout(150);
    const now = await selected();
    check('choosing Continents selects Explorer', now.includes('Explorer'), now.join(', '));
    check('no unusable level is left selected',
      !now.includes('Globetrotter') && !now.includes('Traveller'), now.join(', '));
    check('the unusable levels are disabled',
      (await page.locator('.big-card:disabled').count()) === 2);

    // And it must survive a reload, since settings are remembered.
    await page.reload();
    await page.locator('.setup').waitFor();
    const afterReload = await selected();
    check('the correction is remembered, not re-applied each time',
      afterReload.includes('Explorer') && !afterReload.includes('Globetrotter'),
      afterReload.join(', '));

    // A contradictory setting stored by an older version must also be settled
    // on the way in, which is a different code path from changing a setting.
    await page.evaluate(() => {
      const key = 'passport-club/config/v1';
      const stored = JSON.parse(localStorage.getItem(key) ?? '{}');
      localStorage.setItem(
        key,
        JSON.stringify({ ...stored, mode: 'continent', level: 'globetrotter' }),
      );
    });
    await page.reload();
    await page.locator('.setup').waitFor();
    const fromStorage = await selected();
    check('a contradictory stored setting is settled on load',
      fromStorage.includes('Explorer') && !fromStorage.includes('Globetrotter'),
      fromStorage.join(', '));
  }

  check('no console errors during play', consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | '));
} catch (err) {
  check('suite ran to completion', false, String(err).split('\n')[0]);
} finally {
  await browser.close();
  stopServer();
}

console.log('\n' + lines.join('\n'));
console.log(failures ? `\n${failures} check(s) failed.\n` : '\nAll browser checks passed.\n');
process.exit(failures ? 1 : 0);
