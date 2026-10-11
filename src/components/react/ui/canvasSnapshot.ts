const snapshots = new WeakMap<HTMLCanvasElement, () => SVGGElement>();

export function registerCanvasSnapshot(canvas: HTMLCanvasElement, draw: () => SVGGElement) {
  snapshots.set(canvas, draw);
  return () => {
    snapshots.delete(canvas);
  };
}

export function canvasSnapshot(canvas: HTMLCanvasElement): SVGGElement | undefined {
  return snapshots.get(canvas)?.();
}
