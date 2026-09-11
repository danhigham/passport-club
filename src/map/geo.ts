import {
  geoCentroid,
  geoCircle,
  geoContains,
  geoDistance,
  geoOrthographic,
  geoPath,
} from 'd3-geo';
import type { GeoPermissibleObjects, GeoProjection } from 'd3-geo';
import type { AreaFeature, City } from '../types';

export const EARTH_RADIUS_KM = 6371;
const DEG = 180 / Math.PI;

/** Spherical centroid of any GeoJSON object, as [lon, lat]. */
export function centroidOf(o: GeoPermissibleObjects): [number, number] {
  const c = geoCentroid(o);
  return [c[0], c[1]];
}

/** Great-circle distance in km between two [lon, lat] pairs. */
export function distanceKm(a: [number, number], b: [number, number]): number {
  return geoDistance(a, b) * EARTH_RADIUS_KM;
}

/* =========================================================== the globe ===
 *
 * The map is a real sphere: an orthographic projection you can spin. That
 * choice ripples through everything below.
 *
 * Unlike a flat map, there is no fixed "screen position" for a place — where
 * Japan lands on screen (or whether it is on screen at all) depends on how the
 * globe is currently turned. So instead of a pan/zoom transform sitting on top
 * of a fixed projection, the camera *is* the projection: the rotation decides
 * which face of the Earth you're looking at, and the scale decides how close
 * you are. Every draw and every hit-test re-applies the camera first.
 */

/** What the viewer is looking at: a point on the globe, and how close. */
export interface Camera {
  /** The [lon, lat] currently facing the viewer, dead centre of the canvas. */
  center: [number, number];
  /** 1 = the whole globe fits on screen. 4 = four times closer. */
  zoom: number;
}

export interface Globe {
  projection: GeoProjection;
  width: number;
  height: number;
  /** Projection scale at which the entire sphere fits the canvas. */
  baseScale: number;
  padding: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 60;

export function createGlobe(width: number, height: number, padding = 10): Globe {
  const projection = geoOrthographic()
    .translate([width / 2, height / 2])
    // clipAngle(90) hides the far side of the Earth — the thing that makes it
    // read as a solid ball rather than a transparent shell.
    .clipAngle(90)
    .precision(0.4);

  return {
    projection,
    width,
    height,
    baseScale: Math.max(1, Math.min(width, height) / 2 - padding),
    padding,
  };
}

/** Point the projection at the camera. Call before drawing or hit-testing. */
export function applyCamera(globe: Globe, camera: Camera): GeoProjection {
  return globe.projection
    .rotate([-camera.center[0], -camera.center[1], 0])
    .scale(globe.baseScale * camera.zoom);
}

export function clampCamera(camera: Camera): Camera {
  let lon = camera.center[0];
  // Longitude wraps; latitude must not, or the globe would flip upside-down
  // and "north is up" would stop being true.
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return {
    center: [lon, Math.max(-90, Math.min(90, camera.center[1]))],
    zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom)),
  };
}

/* ------------------------------------------------------ screen <-> globe */

/**
 * Degrees of rotation per pixel of drag, at the current zoom.
 *
 * Derived rather than tuned: on an orthographic projection one pixel at the
 * centre of the disc subtends 1/scale radians, so the globe turns under the
 * finger at roughly the right rate however far you've zoomed in.
 */
export function degreesPerPixel(globe: Globe, camera: Camera): number {
  return DEG / (globe.baseScale * camera.zoom);
}

/**
 * Is this screen pixel actually on the planet, rather than out in space?
 *
 * This has to be asked explicitly, because `projection.invert` will not tell
 * us. d3's `asin` helper *clamps* its argument to [-1, 1] rather than returning
 * NaN, so inverting a point beyond the disc silently yields a perfectly
 * plausible coordinate somewhere on the limb. A click on empty sky therefore
 * looks exactly like a click on the horizon, and gets judged as a real guess.
 */
export function isOnGlobe(globe: Globe, camera: Camera, sx: number, sy: number): boolean {
  const radius = globe.baseScale * camera.zoom;
  const dx = sx - globe.width / 2;
  const dy = sy - globe.height / 2;
  return dx * dx + dy * dy <= radius * radius;
}

/** Screen pixel -> [lon, lat], or null if the click missed the globe. */
export function screenToLonLat(
  globe: Globe,
  camera: Camera,
  sx: number,
  sy: number,
): [number, number] | null {
  if (!isOnGlobe(globe, camera, sx, sy)) return null;
  const projection = applyCamera(globe, camera);
  const inv = projection.invert?.([sx, sy]);
  if (!inv || !Number.isFinite(inv[0]) || !Number.isFinite(inv[1])) return null;
  return [inv[0], inv[1]];
}

/** Is this place on the side of the globe facing us? */
export function isVisible(camera: Camera, lonLat: [number, number]): boolean {
  // A hair under 90° so places right on the horizon aren't drawn edge-on.
  return geoDistance(camera.center, lonLat) < Math.PI / 2 - 0.015;
}

/** Screen position of a place, or null when it's round the back. */
export function lonLatToScreen(
  globe: Globe,
  camera: Camera,
  lonLat: [number, number],
): [number, number] | null {
  if (!isVisible(camera, lonLat)) return null;
  const projection = applyCamera(globe, camera);
  const p = projection(lonLat);
  if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
  return [p[0], p[1]];
}

/* ------------------------------------------------------------ hit-testing */

/**
 * Which polygon contains this point? Tested on the sphere rather than against
 * rendered pixels, so the answer is the same however the globe is turned.
 */
export function findAreaAt(
  features: AreaFeature[],
  lonLat: [number, number],
): AreaFeature | null {
  for (const f of features) {
    if (geoContains(f as GeoPermissibleObjects, lonLat)) return f;
  }
  return null;
}

/** Nearest city to a point, plus how far away it is. */
export function findNearestCity(
  cities: City[],
  lonLat: [number, number],
): { city: City; km: number } | null {
  let best: City | null = null;
  let bestD = Infinity;
  for (const c of cities) {
    const d = geoDistance([c.lon, c.lat], lonLat);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best ? { city: best, km: bestD * EARTH_RADIUS_KM } : null;
}

/**
 * How close does a city click have to be? Scaled from the zoom so the
 * tolerance stays about a fingertip wide whatever the magnification.
 */
export function cityToleranceKm(globe: Globe, camera: Camera, pixels = 26): number {
  const radians = pixels / (globe.baseScale * camera.zoom);
  return Math.max(12, radians * EARTH_RADIUS_KM);
}

/* --------------------------------------------------------- framing shots */

/** The angular radius (degrees) that fills the canvas at a given zoom. */
function fittedRadiusDeg(globe: Globe, zoom: number): number {
  const usable = Math.min(globe.width, globe.height) / 2 - globe.padding;
  const sin = Math.min(1, usable / (globe.baseScale * zoom));
  return Math.asin(sin) * DEG;
}

/** Zoom level at which a cap of `radiusDeg` about the centre just fits. */
export function zoomForRadius(globe: Globe, radiusDeg: number): number {
  const usable = Math.min(globe.width, globe.height) / 2 - globe.padding;
  const sin = Math.sin(Math.max(0.4, radiusDeg) / DEG);
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, usable / (globe.baseScale * sin)));
}

/**
 * A camera that frames a feature: turn the globe so the feature faces us, then
 * move in until it fills the view.
 *
 * The scale is measured rather than guessed — project the feature at scale 1
 * and see how far it actually spreads — because a country's on-screen size
 * depends on where it sits relative to the horizon, not just its area.
 */
export function cameraForFeature(
  globe: Globe,
  feature: GeoPermissibleObjects,
  maxZoom = MAX_ZOOM,
  margin = 1.25,
): Camera {
  const center = geoCentroid(feature) as [number, number];

  const probe = geoOrthographic()
    .translate([0, 0])
    .scale(1)
    .clipAngle(90)
    .rotate([-center[0], -center[1], 0]);
  const [[x0, y0], [x1, y1]] = geoPath(probe).bounds(feature);

  const reach = Math.max(Math.abs(x0), Math.abs(x1), Math.abs(y0), Math.abs(y1));
  const usable = Math.min(globe.width, globe.height) / 2 - globe.padding;

  const zoom =
    Number.isFinite(reach) && reach > 1e-6
      ? usable / (reach * margin * globe.baseScale)
      : MIN_ZOOM;

  return clampCamera({ center, zoom: Math.min(maxZoom, Math.max(MIN_ZOOM, zoom)) });
}

/** A camera looking straight at a point from a given altitude. */
export function cameraForPoint(
  globe: Globe,
  point: [number, number],
  radiusDeg: number,
): Camera {
  return clampCamera({ center: point, zoom: zoomForRadius(globe, radiusDeg) });
}

/** The default view: the whole planet, tilted to show a bit of everything. */
export function worldCamera(): Camera {
  return { center: [10, 18], zoom: MIN_ZOOM };
}

/* -------------------------------------------------------------- the hint */

/**
 * The "it's somewhere in here" circle.
 *
 * Deliberately *not* centred on the answer — that would hand it over. The
 * circle is nudged off-centre by a stable pseudo-random offset derived from the
 * target's id, so the answer sits somewhere inside it but never dead middle,
 * and the same question always produces the same hint.
 */
export function hintCircle(
  targetId: string,
  point: [number, number],
  radiusDeg: number,
): { circle: GeoPermissibleObjects; center: [number, number] } {
  let hash = 0;
  for (let i = 0; i < targetId.length; i++) {
    hash = (hash * 31 + targetId.charCodeAt(i)) | 0;
  }
  const angle = ((hash >>> 0) % 360) * (Math.PI / 180);
  const offset = radiusDeg * 0.45;

  const lat = Math.max(-85, Math.min(85, point[1] + Math.sin(angle) * offset));
  // Converging meridians mean a degree of longitude is a shorter hop the
  // further from the equator you are; widen the step to compensate.
  const lonScale = 1 / Math.max(0.25, Math.cos((lat * Math.PI) / 180));
  const lon = point[0] + Math.cos(angle) * offset * lonScale;
  const center: [number, number] = [lon, lat];

  return {
    circle: geoCircle().center(center).radius(radiusDeg)() as GeoPermissibleObjects,
    center,
  };
}

/** How wide a hint circle should be at the current zoom, in degrees. */
export function hintRadiusDeg(globe: Globe, camera: Camera): number {
  return Math.max(2.5, Math.min(32, fittedRadiusDeg(globe, camera.zoom) * 0.42));
}
