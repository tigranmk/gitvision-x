import { describe, expect, it } from 'vitest';
import { EDGE_OUT, ROW_MERGE, packEdge } from '@gvx/protocol';
import { draw, type DrawInput } from './draw';

/** A 2D context that records the colours it strokes and fills. */
function recorder() {
  const strokes: string[] = [];
  const fills: string[] = [];
  const ctx = new Proxy(
    { strokeStyle: '', fillStyle: '' } as Record<string, unknown>,
    {
      get(t, k) {
        if (k === 'stroke') return () => strokes.push(String(t.strokeStyle));
        if (k === 'fill') return () => fills.push(String(t.fillStyle));
        if (k in t) return t[k as string];
        return () => {};
      },
      set(t, k, v) {
        t[k as string] = v;
        return true;
      },
    },
  );
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes, fills };
}

const input = (contrastBorder: string | null): DrawInput => ({
  width: 40,
  laneWidth: 16,
  height: 44,
  dpr: 1,
  scrollTop: 0,
  first: 0,
  rows: [
    { lane: 0, flags: ROW_MERGE, edges: new Uint32Array([packEdge(EDGE_OUT, 0, 0)]) },
    { lane: 0, flags: 0, edges: new Uint32Array() },
  ],
  theme: { lanes: Array(8).fill('#3794ff'), surface: '#000', contrastBorder, head: '#fff', conflict: '#f00' },
  headRow: -1,
  pulseRow: -1,
  pulse: 1,
  pulseColor: '#ff0',
  lineage: new Int32Array(),
  lineageColor: '#0f0',
});

// Path2D is not in Node: a stand-in that accepts the calls draw() makes.
globalThis.Path2D ??= class {
  moveTo() {}
  lineTo() {}
  bezierCurveTo() {}
} as unknown as typeof Path2D;

describe('draw: high contrast', () => {
  it('outlines every node in the contrast border colour, and only in high-contrast themes', () => {
    const hc = recorder();
    draw(hc.ctx, input('#6fc3df'));
    expect(hc.strokes.filter((c) => c === '#6fc3df')).toHaveLength(2);
    const normal = recorder();
    draw(normal.ctx, input(null));
    expect(normal.strokes).not.toContain('#6fc3df');
  });

  it('draws merges hollow, so shape and not only colour tells them apart', () => {
    const r = recorder();
    draw(r.ctx, input(null));
    expect(r.fills).toContain('#000'); // the merge's hollow centre (surface colour)
  });
});

describe('laneLayout', () => {
  it('keeps 16 px lanes while they fit, squeezes to 6 px, then clips', async () => {
    const { laneLayout } = await import('./draw');
    expect(laneLayout(5, 300)).toEqual({ pitch: 16, width: 88 });
    const squeezed = laneLayout(25, 220);
    expect(squeezed.pitch).toBeCloseTo(212 / 25, 5);
    expect(squeezed.width).toBeCloseTo(220, 5);
    expect(laneLayout(100, 220)).toEqual({ pitch: 6, width: 220 }); // 100 × 6 > 212: clipped at the edge
  });
});
