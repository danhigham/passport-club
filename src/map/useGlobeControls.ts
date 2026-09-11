import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MIN_ZOOM,
  clampCamera,
  degreesPerPixel,
  worldCamera,
  type Camera,
  type Globe,
} from './geo';

/**
 * Spin / zoom / tap handling for the globe.
 *
 * Dragging rotates the sphere rather than sliding a map, so the gesture maps to
 * latitude and longitude instead of x and y. Two deliberate constraints keep it
 * usable for a child:
 *
 *  - north stays up (roll is never applied), so the world never ends up tilted
 *    or upside-down after a few careless swipes;
 *  - the turn rate is derived from the zoom, so a drag moves the same amount of
 *    *surface* under the finger whether you're looking at the whole planet or
 *    at one county.
 */

const TAP_SLOP = 7;
const WHEEL_SENSITIVITY = 0.0022;

/** How long the globe takes to travel back to the round's home view. */
const REFRAME_MS = 700;
/** The slower opening shot, flying from the whole planet into the scope. */
const INTRO_MS = 1000;

export interface GlobeControls {
  camera: Camera;
  isSpinning: boolean;
  /** True while the camera is flying itself somewhere. */
  isAnimating: boolean;
  zoomBy: (factor: number) => void;
  reset: () => void;
  /** Glide to another viewpoint (hints, reveals, starting a round). */
  flyTo: (camera: Camera, ms?: number) => void;
  /** Jump without animating. */
  snapTo: (camera: Camera) => void;
  bind: (el: HTMLElement | null) => void;
}

const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);

/** Shortest way round the globe between two longitudes. */
function lerpLon(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return a + d * t;
}

export function useGlobeControls(
  globe: Globe | null,
  initial: Camera,
  /**
   * Changes only when the player should be re-framed — a new round, a new
   * scope. Deliberately *not* the camera object itself: the opening camera is
   * recomputed whenever the canvas resizes, and resizing happens for mundane
   * reasons mid-round (a feedback line wrapping, a tablet rotating, an on-screen
   * keyboard appearing). Keying the reset on identity instead would snatch the
   * globe back to its starting position while the player was mid-search.
   */
  viewKey: unknown,
  onTap: (x: number, y: number) => void,
  onHover?: (x: number, y: number) => void,
): GlobeControls {
  const [camera, setCamera] = useState<Camera>(initial);
  const [isSpinning, setSpinning] = useState(false);
  const [isAnimating, setAnimating] = useState(false);

  const elRef = useRef<HTMLElement | null>(null);
  const globeRef = useRef(globe);
  const camRef = useRef(camera);
  const initialRef = useRef(initial);
  const tapRef = useRef(onTap);
  const hoverRef = useRef(onHover);
  const rafRef = useRef<number | null>(null);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    startX: number;
    startY: number;
    startCam: Camera;
    moved: boolean;
    pinchDist: number;
  } | null>(null);

  globeRef.current = globe;
  tapRef.current = onTap;
  hoverRef.current = onHover;

  const apply = useCallback((next: Camera) => {
    const clamped = clampCamera(next);
    camRef.current = clamped;
    setCamera(clamped);
  }, []);

  const stopAnimation = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      setAnimating(false);
    }
  };

  const snapTo = useCallback(
    (next: Camera) => {
      stopAnimation();
      apply(next);
    },
    [apply],
  );

  const flyTo = useCallback(
    (to: Camera, ms = 750) => {
      stopAnimation();
      const from = camRef.current;
      const t0 = performance.now();
      const step = (now: number) => {
        const p = Math.min(1, (now - t0) / ms);
        const e = easeInOut(p);
        apply({
          center: [
            lerpLon(from.center[0], to.center[0], e),
            from.center[1] + (to.center[1] - from.center[1]) * e,
          ],
          // Zoom interpolates geometrically: 1->16 should feel like two even
          // doublings, not a slow crawl then a lurch.
          zoom: from.zoom * (to.zoom / from.zoom) ** e,
        });
        if (p < 1) {
          rafRef.current = requestAnimationFrame(step);
        } else {
          rafRef.current = null;
          setAnimating(false);
        }
      };
      setAnimating(true);
      rafRef.current = requestAnimationFrame(step);
    },
    [apply],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      stopAnimation();
      apply({ ...camRef.current, zoom: camRef.current.zoom * factor });
    },
    [apply],
  );

  const reset = useCallback(() => flyTo(initialRef.current, 550), [flyTo]);

  // Keep the "home" viewpoint current at all times, so the reset button frames
  // correctly after a resize — but without moving the camera.
  initialRef.current = initial;

  /* Re-frame only when the view is genuinely meant to change. */
  const lastKey = useRef<unknown>(viewKey);
  const framed = useRef(false);
  useEffect(() => {
    // Nothing can be framed until the canvas has been measured.
    if (!globe) return;
    const keyChanged = !Object.is(lastKey.current, viewKey);
    if (framed.current && !keyChanged) return;
    const isFirstFraming = !framed.current;
    framed.current = true;
    lastKey.current = viewKey;

    const home = initialRef.current;

    if (!isFirstFraming) {
      // Between questions. The camera is usually still parked on the last
      // answer, so flying home shows the player the journey back out rather
      // than teleporting them and leaving them to work out where they now are.
      flyTo(home, REFRAME_MS);
      return;
    }

    stopAnimation();
    if (home.zoom > MIN_ZOOM * 1.15) {
      // Opening shot for a round confined to one region: start on the whole
      // planet and fly in, so a child sees *where in the world* they're about
      // to be playing before the questions start.
      const world = worldCamera();
      camRef.current = world;
      setCamera(world);
      flyTo(home, INTRO_MS);
    } else {
      camRef.current = home;
      setCamera(home);
    }
  }, [viewKey, globe, flyTo]);

  useEffect(() => () => stopAnimation(), []);

  const bind = useCallback((el: HTMLElement | null) => {
    elRef.current = el;
  }, []);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    const local = (e: PointerEvent | WheelEvent): [number, number] => {
      const r = el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };

    const onPointerDown = (e: PointerEvent) => {
      // Deliberately does *not* stop a flight in progress. A finger touching
      // down is not yet an instruction to take over — it might just be a tap —
      // and cancelling here would strand the camera halfway home between
      // questions. Control is seized below, the moment a real drag begins.
      const [x, y] = local(e);
      pointers.current.set(e.pointerId, { x, y });
      el.setPointerCapture(e.pointerId);

      if (pointers.current.size === 1) {
        gesture.current = {
          startX: x,
          startY: y,
          startCam: camRef.current,
          moved: false,
          pinchDist: 0,
        };
      } else if (pointers.current.size === 2) {
        // A second finger is unambiguous: the player wants to pinch.
        stopAnimation();
        const [a, b] = [...pointers.current.values()];
        gesture.current = {
          startX: x,
          startY: y,
          startCam: camRef.current,
          moved: true, // a pinch is never a tap
          pinchDist: Math.hypot(a.x - b.x, a.y - b.y),
        };
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      const [x, y] = local(e);

      if (!pointers.current.has(e.pointerId)) {
        // Not dragging — just tracking the cursor for the hover highlight.
        hoverRef.current?.(x, y);
        return;
      }
      pointers.current.set(e.pointerId, { x, y });

      const g = gesture.current;
      const gl = globeRef.current;
      if (!g || !gl) return;

      if (pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (g.pinchDist > 0) {
          apply({ ...camRef.current, zoom: camRef.current.zoom * (dist / g.pinchDist) });
        }
        g.pinchDist = dist;
        return;
      }

      const dx = x - g.startX;
      const dy = y - g.startY;
      if (!g.moved && Math.hypot(dx, dy) > TAP_SLOP) {
        g.moved = true;
        setSpinning(true);
        // Now it's a real drag, so take the wheel. Rebase the gesture on where
        // the camera has actually flown to, otherwise the globe would jump back
        // to wherever it happened to be when the finger first landed.
        stopAnimation();
        g.startCam = camRef.current;
        g.startX = x;
        g.startY = y;
        return;
      }
      if (!g.moved) return;

      const k = degreesPerPixel(gl, g.startCam);
      // Drag right => the surface follows the finger east => the point now
      // facing us is further west, hence the subtraction.
      apply({
        center: [g.startCam.center[0] - dx * k, g.startCam.center[1] + dy * k],
        zoom: g.startCam.zoom,
      });
    };

    const endPointer = (e: PointerEvent) => {
      if (!pointers.current.has(e.pointerId)) return;
      const [x, y] = local(e);
      pointers.current.delete(e.pointerId);
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);

      const g = gesture.current;
      if (pointers.current.size === 0) {
        gesture.current = null;
        setSpinning(false);
        if (g && !g.moved && e.type === 'pointerup') tapRef.current(x, y);
      } else if (pointers.current.size === 1) {
        // One finger lifted mid-pinch: restart a clean drag from the other.
        const [p] = [...pointers.current.values()];
        gesture.current = {
          startX: p.x,
          startY: p.y,
          startCam: camRef.current,
          moved: true,
          pinchDist: 0,
        };
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stopAnimation();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      apply({
        ...camRef.current,
        zoom: camRef.current.zoom * Math.exp(-e.deltaY * unit * WHEEL_SENSITIVITY),
      });
    };

    const onLeave = () => hoverRef.current?.(-1, -1);

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', endPointer);
    el.addEventListener('pointercancel', endPointer);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', endPointer);
      el.removeEventListener('pointercancel', endPointer);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('wheel', onWheel);
    };
  }, [apply, globe]);

  return { camera, isSpinning, isAnimating, zoomBy, reset, flyTo, snapTo, bind };
}
