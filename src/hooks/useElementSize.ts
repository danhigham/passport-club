import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export interface Size {
  width: number;
  height: number;
}

/**
 * Track an element's rendered size. The map needs this to build a projection
 * that fits the available space — and to rebuild it when the window, the
 * on-screen keyboard, or a phone rotation changes that space.
 */
export function useElementSize<T extends HTMLElement>(): [
  (node: T | null) => void,
  Size,
] {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    if (!node) return;

    const measure = () => {
      const r = node.getBoundingClientRect();
      setSize((prev) => {
        const w = Math.round(r.width);
        const h = Math.round(r.height);
        // Ignore sub-pixel jitter; re-projecting is not free.
        return prev.width === w && prev.height === h ? prev : { width: w, height: h };
      });
    };

    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(node);
  }, []);

  useLayoutEffect(() => () => observer.current?.disconnect(), []);

  return [ref, size];
}
