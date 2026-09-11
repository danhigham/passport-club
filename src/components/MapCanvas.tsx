import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { geoPath } from 'd3-geo';
import type { GeoPermissibleObjects } from 'd3-geo';
import type { CoreData } from '../data/datasets';
import {
  cameraForFeature,
  cameraForPoint,
  cityToleranceKm,
  createGlobe,
  findAreaAt,
  hintCircle,
  hintRadiusDeg,
  isVisible,
  lonLatToScreen,
  screenToLonLat,
  worldCamera,
  type Camera,
  type Globe,
} from '../map/geo';
import { renderGlobe, renderStats, resetRenderStats, type Scene } from '../map/render';
import { createRasterGlobe, loadEarthTextures, type RasterGlobe } from '../map/rasterGlobe';
import { useGlobeControls } from '../map/useGlobeControls';
import type { Session } from '../game/session';
import { isArmed, type JudgeInput, type RoundState } from '../game/useGame';
import type { AreaFeature, City } from '../types';
import { useElementSize } from '../hooks/useElementSize';

interface Props {
  session: Session;
  core: CoreData;
  round: RoundState | null;
  onGuess: (input: JudgeInput) => void;
}

/**
 * Zoom at which full-resolution outlines start being drawn. Below this the
 * globe is small enough that the simplified copy is indistinguishable.
 */
const DETAIL_ZOOM = 1.8;

/** A label only appears once its shape is at least this wide on screen. */
const LABEL_MIN_PX = 40;

interface LabelDatum {
  id: string;
  name: string;
  point: [number, number];
  /** Rough angular width, used to decide when the shape is big enough to name. */
  spanDeg: number;
}

export function MapCanvas({ session, core, round, onGuess }: Props) {
  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { config } = session;

  const globe = useMemo<Globe | null>(
    () => (size.width && size.height ? createGlobe(size.width, size.height) : null),
    [size.width, size.height],
  );

  /* ------------------------------------------------- where we start looking */

  const startCamera = useMemo<Camera>(() => {
    if (!globe) return worldCamera();
    // A curated viewpoint wins (continents), then measured geometry (a single
    // country), then the whole planet.
    if (session.home) return cameraForPoint(globe, session.home.center, session.home.radiusDeg);
    if (session.focus) return cameraForFeature(globe, session.focus, 14, 1.35);
    return worldCamera();
  }, [globe, session.home, session.focus]);

  /* ----------------------------------------------------------- interaction */

  const [hoverId, setHoverId] = useState<string | null>(null);
  const liveRef = useRef({ globe, round, camera: startCamera, animating: false });

  const handleTap = useCallback(
    (x: number, y: number) => {
      const { globe: g, round: r, camera, animating } = liveRef.current;
      if (!g || !r || r.status !== 'guessing') return;
      // Rounds advance on their own after a correct answer, so a tap aimed at
      // the old question can arrive just after the new one appears. Don't spend
      // one of the player's three guesses on it.
      if (!isArmed(r)) return;
      // Nor on a guess made while the globe is still flying home: the player
      // would be aiming at a target sliding out from under their finger.
      if (animating) return;
      const lonLat = screenToLonLat(g, camera, x, y);
      // A tap that misses the globe entirely (out in space) isn't a guess.
      if (!lonLat) return;
      onGuess({ lonLat, cityToleranceKm: cityToleranceKm(g, camera) });
    },
    [onGuess],
  );

  const handleHover = useCallback(
    (x: number, y: number) => {
      const { globe: g, round: r, camera } = liveRef.current;
      if (!g || !r || r.status !== 'guessing' || x < 0) {
        setHoverId(null);
        return;
      }
      const lonLat = screenToLonLat(g, camera, x, y);
      if (!lonLat) {
        setHoverId(null);
        return;
      }
      const hit = findAreaAt(session.hitAreas, lonLat);
      setHoverId(hit?.properties.id ?? null);
    },
    [session.hitAreas],
  );

  /*
   * Re-frame the globe on a new round or a new game, and at no other time.
   * Notably not on resize: the player's own spinning and zooming must survive
   * the layout moving underneath them.
   */
  const gameId = useRef(0);
  const gameKey = useMemo(() => ++gameId.current, [session]);
  const viewKey = `${gameKey}:${round?.index ?? -1}`;

  const controls = useGlobeControls(globe, startCamera, viewKey, handleTap, handleHover);
  const camera = controls.camera;
  liveRef.current = { globe, round, camera, animating: controls.isAnimating };

  /*
   * The satellite layer. Created once and kept for the life of the component:
   * a WebGL context is expensive to build and browsers cap how many may exist.
   * It renders to its own offscreen canvas, which the 2D layer composites, so
   * the drawing order stays in one place.
   */
  const rasterRef = useRef<RasterGlobe | null>(null);
  const [textureVersion, setTextureVersion] = useState(0);

  useEffect(() => {
    /*
     * Built here rather than during render, and cleared on teardown, so that a
     * remount builds a fresh one.
     *
     * React mounts effects twice in development on purpose, to shake out
     * exactly this. Holding the GL objects outside that cycle meant the first
     * teardown deleted the shader and the texture while the ref still pointed
     * at the corpse; the second mount uploaded an image to a deleted texture,
     * declared itself ready, and drew nothing. The globe then rendered as
     * satellite -- no painted land, because the photograph was supposed to
     * provide it -- over an empty canvas. Production builds do not double-mount,
     * so it only ever appeared in `npm run dev`.
     */
    const raster = createRasterGlobe();
    rasterRef.current = raster;
    if (!raster) return;

    let live = true;
    loadEarthTextures(import.meta.env.BASE_URL, (image) => {
      if (!live) return;
      raster.setTexture(image);
      setTextureVersion((v) => v + 1); // repaint with whatever just arrived
    });

    return () => {
      live = false;
      raster.destroy();
      rasterRef.current = null;
    };
  }, []);

  const [hasSpun, setHasSpun] = useState(false);
  useEffect(() => {
    if (controls.isSpinning) setHasSpun(true);
  }, [controls.isSpinning]);

  /* --------------------------------------------------- what's on the globe */

  const target = round?.target ?? null;
  const revealed = round?.status === 'revealed' || round?.status === 'correct';

  const answerShape = useMemo<GeoPermissibleObjects | null>(() => {
    if (!target || !revealed) return null;
    if (target.kind === 'continent') {
      return {
        type: 'FeatureCollection',
        features: session.countries.filter((c) => c.properties.continent === target.id),
      } as unknown as GeoPermissibleObjects;
    }
    return (target.feature as unknown as GeoPermissibleObjects) ?? null;
  }, [target, revealed, session.countries]);

  const parentShape = useMemo<GeoPermissibleObjects | null>(() => {
    if (!target || !config.narrowToParent) return null;
    if (target.kind === 'city' && target.parentId) {
      return (core.countryById.get(target.parentId) as unknown as GeoPermissibleObjects) ?? null;
    }
    if (target.kind === 'country') {
      const continent = core.countryById.get(target.id)?.properties.continent;
      if (!continent) return null;
      return {
        type: 'FeatureCollection',
        features: session.countries.filter((c) => c.properties.continent === continent),
      } as unknown as GeoPermissibleObjects;
    }
    return null;
  }, [target, config.narrowToParent, core, session.countries]);

  /**
   * The hint is computed once, when it's asked for, and then held. If it were
   * recomputed as the camera moved, the circle would resize under the player
   * while they were busy zooming into it.
   */
  const [hint, setHint] = useState<{
    id: string;
    shape: GeoPermissibleObjects;
    center: [number, number];
  } | null>(null);

  useEffect(() => {
    if (!round?.hintUsed || !target || !globe) {
      setHint(null);
      return;
    }
    if (hint?.id === target.id) return;
    const radius = hintRadiusDeg(globe, liveRef.current.camera);
    const { circle, center } = hintCircle(target.id, target.point, radius);
    setHint({ id: target.id, shape: circle, center });
    // Spin the globe round to show the circle: on a sphere, "here's a clue"
    // is useless if the clue is on the far side.
    controls.flyTo(cameraForPoint(globe, center, radius * 1.9), 700);
  }, [round?.hintUsed, target, globe, hint?.id, controls]);

  /* Fly to the answer when a round ends, so the player sees where it was. */
  useEffect(() => {
    if (!globe || !target || round?.status !== 'revealed') return;
    const to =
      target.feature != null
        ? cameraForFeature(globe, target.feature as unknown as GeoPermissibleObjects, 16, 2.4)
        : cameraForPoint(globe, target.point, target.kind === 'city' ? 9 : 26);
    controls.flyTo(to, 800);
    // `controls` is stable per globe; re-running on every render would restart
    // the flight on each animation frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globe, target, round?.status]);

  /* ------------------------------------------------------------- painting */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !globe) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== globe.width * dpr || canvas.height !== globe.height * dpr) {
      canvas.width = globe.width * dpr;
      canvas.height = globe.height * dpr;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    /*
     * Detail is only worth paying for when it can be seen and there is time to
     * draw it. While the globe is moving every frame re-projects the world from
     * scratch, so a spin uses the simplified copy; so does the world view,
     * where the globe is a few hundred pixels across and 50m detail is an order
     * of magnitude finer than a pixel.
     */
    const moving = controls.isSpinning || controls.isAnimating;
    const detailed = !moving && camera.zoom >= DETAIL_ZOOM;

    const raster = rasterRef.current;
    const satellite = config.basemap === 'satellite' && !!raster?.ready;
    if (satellite) raster!.render(globe, camera, dpr);

    const scene: Scene = {
      countries: detailed ? session.countries : session.countriesCoarse,
      areas: detailed ? session.areas : session.areasCoarse,
      showBorders: config.showBorders,
      continentTint: config.mode === 'continent' && config.showBorders,
      // In admin1 mode the country's own outline is left unstroked; its
      // divisions define the border at a far higher resolution.
      hostId:
        config.mode === 'admin1' && config.scope.type === 'country'
          ? config.scope.id
          : null,
      hoverId,
      parent: parentShape,
      hint: revealed ? null : (hint?.shape ?? null),
      answer: answerShape,
      raster: satellite ? raster!.canvas : null,
    };
    renderGlobe(ctx, globe, camera, scene);
  }, [
    globe,
    camera,
    controls.isSpinning,
    controls.isAnimating,
    session.countries,
    session.countriesCoarse,
    session.areas,
    session.areasCoarse,
    config.showBorders,
    config.mode,
    config.scope,
    config.basemap,
    textureVersion,
    hoverId,
    parentShape,
    hint,
    revealed,
    answerShape,
  ]);

  /* --------------------------------------------------------- screen layer */

  const labels = useMemo<LabelDatum[]>(() => {
    if (!config.showLabels) return [];
    const source: AreaFeature[] = session.areas.length ? session.areas : session.countries;
    const measure = geoPath();
    return source.map((f) => {
      const bounds = measure.bounds(f as unknown as GeoPermissibleObjects);
      return {
        id: f.properties.id,
        name: f.properties.name,
        point: f.properties.point,
        spanDeg: Math.max(bounds[1][0] - bounds[0][0], bounds[1][1] - bounds[0][1]),
      };
    });
  }, [config.showLabels, session.areas, session.countries]);

  const project = useCallback(
    (lonLat: [number, number]) => (globe ? lonLatToScreen(globe, camera, lonLat) : null),
    [globe, camera],
  );

  /** Pixels per degree at the centre of the disc, for label culling. */
  const pxPerDeg = globe ? (globe.baseScale * camera.zoom * Math.PI) / 180 : 0;

  /**
   * Place labels largest-first, dropping any that would collide with one
   * already placed.
   *
   * Without this, dense regions turn to mush — the Balkans and Benelux stack a
   * dozen names on top of each other and none of them can be read, which makes
   * the "show place names" helper actively unhelpful in exactly the places a
   * beginner most needs it.
   */
  const visibleLabels = useMemo(() => {
    if (!globe) return [];
    const candidates = labels
      .filter((l) => l.id !== target?.id) // never name the answer
      .filter((l) => l.spanDeg * pxPerDeg >= LABEL_MIN_PX)
      .filter((l) => isVisible(camera, l.point))
      .sort((a, b) => b.spanDeg - a.spanDeg);

    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const out: { id: string; name: string; x: number; y: number }[] = [];

    for (const l of candidates) {
      const p = project(l.point);
      if (!p) continue;
      // Cheap text metrics: good enough to keep names apart, and far cheaper
      // than measuring every string on the canvas each frame.
      const halfW = l.name.length * 2.9 + 4;
      const box = { x0: p[0] - halfW, y0: p[1] - 7, x1: p[0] + halfW, y1: p[1] + 5 };
      const clash = placed.some(
        (q) => box.x0 < q.x1 && box.x1 > q.x0 && box.y0 < q.y1 && box.y1 > q.y0,
      );
      if (clash) continue;
      placed.push(box);
      out.push({ id: l.id, name: l.name, x: p[0], y: p[1] });
    }
    return out;
  }, [labels, globe, camera, pxPerDeg, project, target?.id]);

  const dotCities = useMemo<City[]>(() => {
    if (config.mode !== 'city' || !config.showCityDots) return [];
    const inPlay = new Set(session.targets.map((t) => t.id));
    // Only the cities that could actually be asked about, so the dots are a
    // genuine multiple-choice aid rather than decoration.
    return session.cities.filter((c) => inPlay.has(c.id));
  }, [config.mode, config.showCityDots, session.cities, session.targets]);

  const targetScreen = target && revealed ? project(target.point) : null;

  /* Testing seam — only attached when explicitly requested with ?e2e=1. */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!new URLSearchParams(window.location.search).has('e2e')) return;
    (window as unknown as Record<string, unknown>).__passportClub = {
      target: target && { id: target.id, name: target.name, point: target.point },
      status: round?.status ?? null,
      /** Live, because arming is a matter of elapsed time, not render state. */
      armed: () => isArmed(round),
      animating: controls.isAnimating,
      renderStats,
      resetRenderStats,
      guesses: round?.guesses.map((g) => ({ at: g.at, verdict: g.verdict })) ?? [],
      hint: hint && { center: hint.center },
      camera,
      project,
      /** Turn the globe to face a place, so a test can click it. */
      faceTo: (lonLat: [number, number]) =>
        globe && controls.snapTo({ center: lonLat, zoom: camera.zoom }),
      setCamera: (center: [number, number], zoom: number) =>
        globe && controls.snapTo({ center, zoom }),
      /** Screen pixel -> [lon, lat], for checking the raster layer's geometry. */
      unproject: (x: number, y: number) =>
        globe ? screenToLonLat(globe, camera, x, y) : null,
    };
  }, [target, round, camera, project, globe, controls, hint]);

  return (
    <div className="map-shell" ref={containerRef}>
      <div
        className={`globe-stage ${controls.isSpinning ? 'spinning' : ''} ${
          round?.status === 'guessing' ? 'live' : 'settled'
        }`}
        ref={controls.bind}
        role="application"
        aria-label={target ? `Spinnable globe. Find ${target.name}.` : 'Spinnable globe'}
      >
        <canvas
          ref={canvasRef}
          className="globe-canvas"
          style={{ width: size.width, height: size.height }}
        />

        {globe && (
          <svg
            className="globe-overlay"
            width={globe.width}
            height={globe.height}
            viewBox={`0 0 ${globe.width} ${globe.height}`}
            aria-hidden="true"
          >
            {visibleLabels.map((l) => (
              <text key={l.id} className="place-label" x={l.x} y={l.y}>
                {l.name}
              </text>
            ))}

            {dotCities.map((c) => {
              const p = project([c.lon, c.lat]);
              if (!p) return null;
              const isTarget = revealed && target?.id === c.id;
              return (
                <circle
                  key={c.id}
                  className={isTarget ? 'city-dot found' : 'city-dot'}
                  cx={p[0]}
                  cy={p[1]}
                  r={isTarget ? 8 : 4.5}
                />
              );
            })}

            {round?.guesses.map((g, i) => {
              if (g.verdict === 'correct') return null;
              const p = project(g.at);
              if (!p) return null;
              return (
                <g key={i} className="miss-mark" transform={`translate(${p[0]},${p[1]})`}>
                  <circle r="13" />
                  <path d="M-5,-5 L5,5 M5,-5 L-5,5" />
                </g>
              );
            })}

            {targetScreen && (
              <g
                className="answer-pin"
                transform={`translate(${targetScreen[0]},${targetScreen[1]})`}
              >
                <circle className="pulse" r="26" />
                <circle className="dot" r="9" />
                <text className="pin-label" y="-22">
                  {target?.name}
                </text>
              </g>
            )}
          </svg>
        )}
      </div>

      <div className="map-controls">
        <button type="button" onClick={() => controls.zoomBy(1.6)} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={() => controls.zoomBy(1 / 1.6)} aria-label="Zoom out">
          &minus;
        </button>
        <button type="button" onClick={controls.reset} aria-label="Reset the view">
          {'\u2302'}
        </button>
      </div>

      {/* Shown until the player discovers spinning for themselves. */}
      {!hasSpun && (
        <p className="spin-hint" aria-hidden="true">
          Drag to spin the globe
        </p>
      )}
    </div>
  );
}
