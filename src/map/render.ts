import { geoDistance, geoGraticule10, geoPath } from 'd3-geo';
import type { GeoPermissibleObjects, GeoProjection } from 'd3-geo';
import { applyCamera, capOf, visibleRadians, type Camera, type Globe } from './geo';
import type { Admin1Feature, AreaFeature, CountryFeature } from '../types';

/**
 * Canvas renderer for the globe.
 *
 * Canvas rather than SVG because an orthographic projection has to be
 * recomputed from scratch on every frame of a spin — there is no transform that
 * can fake turning a sphere. Handing 4,000 freshly-generated path strings to
 * the DOM sixty times a second is not viable; painting them is.
 *
 * Text and markers stay in an SVG layer above this, where they can be crisp and
 * accessible.
 */

/** Mirrors the custom properties in styles.css. Keep the two in step. */
const PALETTE = {
  space: '#0b1524',
  star: 'rgba(255,255,255,0.85)',
  atmosphere: '#4aa3dd',
  oceanLit: '#3d8fc7',
  oceanDark: '#14476e',
  graticule: 'rgba(255,255,255,0.14)',
  land: '#f2e3c4',
  landEdge: '#c2a578',
  landHover: '#fff3d0',
  admin1Edge: '#b08f63',
  rim: 'rgba(150,214,255,0.85)',
  violet: '#7a6cf0',
  violetFill: 'rgba(122,108,240,0.34)',
  sun: '#ffb93d',
  sunFill: 'rgba(255,185,61,0.22)',
  mint: '#34c98a',
  continent: {
    Africa: '#f0a04b',
    Asia: '#e36d6d',
    Europe: '#7ec4a4',
    'North America': '#74a9e8',
    'South America': '#c99ae0',
    Oceania: '#f2cd5c',
    Antarctica: '#cfe4f2',
  } as Record<string, string>,
};

export interface Scene {
  countries: CountryFeature[];
  areas: Admin1Feature[];
  showBorders: boolean;
  continentTint: boolean;
  /**
   * The country whose sub-divisions are being played, if any.
   *
   * Its own outline is never stroked. The country border comes from Natural
   * Earth's 50m set while its states and counties come from 10m, so the two
   * disagree by a kilometre here and there — and a coarse line drawn along the
   * edge of a finer mosaic reads as a mistake, because it is one. The mosaic
   * tiles the country exactly, so its outer edge *is* the border, drawn at the
   * resolution the player is actually looking at.
   *
   * The fill underneath is still painted: it is the same colour as the
   * divisions, so it cannot be seen, but it backs any hairline where the two
   * datasets disagree and stops ocean showing through.
   */
  hostId: string | null;
  /** Feature the pointer is over, highlighted so taps feel responsive. */
  hoverId: string | null;
  /** Violet "the answer is inside this" context shape. */
  parent: GeoPermissibleObjects | null;
  /** Dashed "somewhere in here" hint circle. */
  hint: GeoPermissibleObjects | null;
  /** Green reveal shape, once the round is over. */
  answer: GeoPermissibleObjects | null;
}

/**
 * Rolling record of how long recent frames took to paint.
 *
 * Kept always-on because it costs two clock reads per frame, and rendering cost
 * is the single thing most likely to regress on this project: every frame of a
 * spin re-projects the world from scratch.
 */
const FRAME_SAMPLES = 120;
const frameTimes: number[] = [];

export function renderStats() {
  if (!frameTimes.length) return null;
  const sorted = [...frameTimes].sort((a, b) => a - b);
  const mean = frameTimes.reduce((s, n) => s + n, 0) / frameTimes.length;
  return {
    frames: frameTimes.length,
    mean: +mean.toFixed(2),
    p50: +sorted[sorted.length >> 1].toFixed(2),
    p95: +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))].toFixed(2),
    max: +sorted[sorted.length - 1].toFixed(2),
  };
}

export function resetRenderStats() {
  frameTimes.length = 0;
}

const SPHERE = { type: 'Sphere' } as GeoPermissibleObjects;
const GRATICULE = geoGraticule10() as unknown as GeoPermissibleObjects;

/**
 * Project a set of features into a single reusable Path2D.
 *
 * The point is that projection happens exactly once. Previously the same
 * geometry was walked twice, once to fill and again to stroke, which meant
 * re-projecting a hundred thousand vertices to draw the very same outline.
 * A Path2D holds the projected result so the second pass is free.
 */
function buildPath(
  projection: GeoProjection,
  features: Iterable<AreaFeature>,
  camera: Camera,
  horizon: number,
): Path2D {
  const path2d = new Path2D();
  const draw = geoPath(projection, path2d as unknown as CanvasRenderingContext2D);
  for (const f of features) {
    if (!f.geometry) continue; // dropped at this level of detail
    const cap = capOf(f);
    if (geoDistance(camera.center, cap.center) - cap.radius > horizon) continue;
    draw(f as unknown as GeoPermissibleObjects);
  }
  return path2d;
}

/* ------------------------------------------------------------- starfield */

let starCache: { w: number; h: number; stars: [number, number, number][] } | null = null;

/**
 * A fixed backdrop of stars. Generated once per canvas size and held in screen
 * space — the stars are meant to be the distant sky, so they must *not* turn
 * with the globe.
 */
function stars(w: number, h: number): [number, number, number][] {
  if (starCache && starCache.w === w && starCache.h === h) return starCache.stars;
  const out: [number, number, number][] = [];
  // A deterministic generator, so the sky doesn't reshuffle on every resize.
  let seed = 1337;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const count = Math.round((w * h) / 5200);
  for (let i = 0; i < count; i++) {
    out.push([rand() * w, rand() * h, rand() * 1.1 + 0.25]);
  }
  starCache = { w, h, stars: out };
  return out;
}

/* ---------------------------------------------------------------- render */

export function renderGlobe(
  ctx: CanvasRenderingContext2D,
  globe: Globe,
  camera: Camera,
  scene: Scene,
): void {
  const { width: w, height: h } = globe;
  const projection = applyCamera(globe, camera);
  const path = geoPath(projection, ctx);

  const cx = w / 2;
  const cy = h / 2;
  const r = globe.baseScale * camera.zoom;
  const started = performance.now();

  ctx.save();
  ctx.clearRect(0, 0, w, h);

  /* --- deep space --- */
  ctx.fillStyle = PALETTE.space;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = PALETTE.star;
  for (const [sx, sy, sr] of stars(w, h)) {
    ctx.globalAlpha = sr * 0.55;
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  /* --- atmosphere: a halo just outside the limb --- */
  if (r < Math.max(w, h)) {
    const halo = ctx.createRadialGradient(cx, cy, r * 0.96, cx, cy, r * 1.14);
    halo.addColorStop(0, 'rgba(74,163,221,0.45)');
    halo.addColorStop(0.5, 'rgba(74,163,221,0.16)');
    halo.addColorStop(1, 'rgba(74,163,221,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.14, 0, Math.PI * 2);
    ctx.fill();
  }

  /* --- the ocean, lit from the upper left --- */
  // The sphere outline is needed three times (ocean, limb shading, rim light),
  // so project it once.
  const spherePath = new Path2D();
  geoPath(projection, spherePath as unknown as CanvasRenderingContext2D)(SPHERE);

  const sea = ctx.createRadialGradient(
    cx - r * 0.35,
    cy - r * 0.42,
    r * 0.05,
    cx,
    cy,
    r * 1.05,
  );
  sea.addColorStop(0, PALETTE.oceanLit);
  sea.addColorStop(1, PALETTE.oceanDark);
  ctx.fillStyle = sea;
  ctx.fill(spherePath);

  /* --- graticule --- */
  ctx.strokeStyle = PALETTE.graticule;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  path(GRATICULE);
  ctx.stroke();

  /* --- land --- */
  ctx.lineJoin = 'round';
  const horizon = visibleRadians(globe, camera);

  if (scene.continentTint) {
    // Grouped by continent so each lands in one fill call.
    const groups = new Map<string, CountryFeature[]>();
    for (const c of scene.countries) {
      const key = c.properties.continent;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(c);
    }
    const outlines = new Path2D();
    for (const [continent, members] of groups) {
      const group = buildPath(projection, members, camera, horizon);
      ctx.fillStyle = PALETTE.continent[continent] ?? PALETTE.land;
      ctx.fill(group);
      outlines.addPath(group);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 0.5;
    ctx.stroke(outlines);
  } else {
    const land = buildPath(projection, scene.countries, camera, horizon);
    ctx.fillStyle = PALETTE.land;
    ctx.fill(land);

    if (scene.showBorders) {
      // The host country's own border is omitted: its divisions are drawn on
      // top at a far higher resolution, and a coarse line along the edge of a
      // finer mosaic reads as a mistake.
      const borders = scene.hostId
        ? buildPath(
            projection,
            scene.countries.filter((f) => f.properties.id !== scene.hostId),
            camera,
            horizon,
          )
        : land;
      ctx.strokeStyle = PALETTE.landEdge;
      ctx.lineWidth = 0.9;
      ctx.stroke(borders);
    }
  }

  /* --- states / provinces / counties --- */
  if (scene.areas.length) {
    const areas = buildPath(projection, scene.areas, camera, horizon);
    ctx.fillStyle = PALETTE.land;
    ctx.fill(areas);

    if (scene.showBorders) {
      ctx.strokeStyle = PALETTE.admin1Edge;
      ctx.lineWidth = 0.85;
      ctx.stroke(areas);
    }
  }

  /* --- hover --- */
  if (scene.hoverId) {
    const pool = (scene.areas.length ? scene.areas : scene.countries).filter(
      (f) => f.properties.id === scene.hoverId,
    );
    if (pool.length) {
      ctx.fillStyle = PALETTE.landHover;
      ctx.fill(buildPath(projection, pool, camera, horizon));
    }
  }

  /* --- assists and answers --- */
  if (scene.parent) {
    ctx.fillStyle = PALETTE.violetFill;
    ctx.strokeStyle = PALETTE.violet;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    path(scene.parent);
    ctx.fill();
    ctx.stroke();
  }

  if (scene.hint) {
    ctx.fillStyle = PALETTE.sunFill;
    ctx.strokeStyle = PALETTE.sun;
    ctx.lineWidth = 3;
    ctx.setLineDash([9, 7]);
    ctx.beginPath();
    path(scene.hint);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (scene.answer) {
    ctx.fillStyle = PALETTE.mint;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    path(scene.answer);
    ctx.fill();
    ctx.stroke();
  }

  /* --- limb shading: darken towards the edge so it reads as a ball --- */
  const limb = ctx.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
  limb.addColorStop(0, 'rgba(0,0,0,0)');
  limb.addColorStop(0.82, 'rgba(4,14,28,0.12)');
  limb.addColorStop(1, 'rgba(4,14,28,0.42)');
  ctx.fillStyle = limb;
  ctx.fill(spherePath);

  /* --- rim light --- */
  ctx.strokeStyle = PALETTE.rim;
  ctx.lineWidth = 1.4;
  ctx.stroke(spherePath);

  ctx.restore();

  frameTimes.push(performance.now() - started);
  if (frameTimes.length > FRAME_SAMPLES) frameTimes.shift();
}
