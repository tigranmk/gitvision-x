/** Blob Web Worker (D6): owns the graph's OffscreenCanvas and draws the frames the webview posts. */
import { draw } from './draw';
import { size, unpack, type RenderMessage } from './frame';

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let pending: RenderMessage & { kind: 'frame' } | null = null;
let scheduled = false;

self.onmessage = (e: MessageEvent<RenderMessage>) => {
  const m = e.data;
  if (m.kind === 'init') {
    canvas = m.canvas;
    ctx = canvas.getContext('2d');
    return;
  }
  // Draw only the latest frame if several arrive before the worker gets to them.
  pending = m;
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(flush);
  }
};

function flush(): void {
  scheduled = false;
  const m = pending;
  pending = null;
  if (!m || !canvas || !ctx) return;
  size(canvas, m.frame);
  draw(ctx, unpack(m.frame));
  self.postMessage({ sentAt: m.frame.sentAt });
}

self.postMessage({ kind: 'ready' });
