import { geoGraticule10, geoPath } from 'd3-geo';
import type { GeoPermissibleObjects } from 'd3-geo';
import { applyCamera, type Camera, type Globe } from './geo';
import type { Admin1Feature, CountryFeature } from '../types';

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
  /** Feature the pointer is over, highlighted so taps feel responsive. */
  hoverId: string | null;
  /** Violet "the answer is inside this" context shape. */
  parent: GeoPermissibleObjects | null;
  /** Dashed "somewhere in here" hint circle. */
  hint: GeoPermissibleObjects | null;
  /** Green reveal shape, once the round is over. */
  answer: GeoPermissibleObjects | null;
}

const SPHERE = { type: 'Sphere' } as GeoPermissibleObjects;
const GRATICULE = geoGraticule10() as unknown as GeoPermissibleObjects;

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
  ctx.beginPath();
  path(SPHERE);
  ctx.fill();

  /* --- graticule --- */
  ctx.strokeStyle = PALETTE.graticule;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  path(GRATICULE);
  ctx.stroke();

  /* --- land --- */
  ctx.lineJoin = 'round';
  if (scene.continentTint) {
    // Grouped by continent so each lands in one fill call.
    const groups = new Map<string, CountryFeature[]>();
    for (const c of scene.countries) {
      const key = c.properties.continent;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(c);
    }
    for (const [continent, members] of groups) {
      ctx.fillStyle = PALETTE.continent[continent] ?? PALETTE.land;
      ctx.beginPath();
      for (const f of members) path(f as unknown as GeoPermissibleObjects);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (const f of scene.countries) path(f as unknown as GeoPermissibleObjects);
    ctx.stroke();
  } else {
    ctx.fillStyle = PALETTE.land;
    ctx.beginPath();
    for (const f of scene.countries) path(f as unknown as GeoPermissibleObjects);
    ctx.fill();

    if (scene.showBorders) {
      ctx.strokeStyle = PALETTE.landEdge;
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      for (const f of scene.countries) path(f as unknown as GeoPermissibleObjects);
      ctx.stroke();
    }
  }

  /* --- states / provinces / counties --- */
  if (scene.areas.length) {
    ctx.fillStyle = PALETTE.land;
    ctx.beginPath();
    for (const f of scene.areas) path(f as unknown as GeoPermissibleObjects);
    ctx.fill();

    if (scene.showBorders) {
      ctx.strokeStyle = PALETTE.admin1Edge;
      ctx.lineWidth = 0.85;
      ctx.beginPath();
      for (const f of scene.areas) path(f as unknown as GeoPermissibleObjects);
      ctx.stroke();
    }
  }

  /* --- hover --- */
  if (scene.hoverId) {
    const pool: GeoPermissibleObjects[] = (
      scene.areas.length ? scene.areas : scene.countries
    ).filter((f) => f.properties.id === scene.hoverId) as unknown as GeoPermissibleObjects[];
    if (pool.length) {
      ctx.fillStyle = PALETTE.landHover;
      ctx.beginPath();
      for (const f of pool) path(f);
      ctx.fill();
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
  ctx.beginPath();
  path(SPHERE);
  ctx.fill();

  /* --- rim light --- */
  ctx.strokeStyle = PALETTE.rim;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  path(SPHERE);
  ctx.stroke();

  ctx.restore();
}
