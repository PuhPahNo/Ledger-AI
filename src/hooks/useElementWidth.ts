import { useEffect, useState } from 'react';

/**
 * Width of an element, kept current with a ResizeObserver. Use the returned callback as the
 * element's `ref` (a callback ref, so it also works for nodes that mount after data loads).
 */
export function useElementWidth<T extends HTMLElement = HTMLDivElement>(): [(node: T | null) => void, number] {
  const [node, setNode] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!node) return;
    setWidth(node.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, width];
}
