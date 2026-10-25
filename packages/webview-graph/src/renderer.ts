/**
 * Graph canvas renderer (D6): draws in a blob Web Worker on an OffscreenCanvas when the webview allows
 * it, otherwise on the main thread. Both run the same draw(); the worker gets each frame's visible rows
 * packed into a few typed arrays.
 */
import { draw, type DrawInput } from './draw';
import { pack, size, type RenderMessage } from './frame';
import RenderWorker from './renderWorker?worker&inline';

export interface GraphRenderer {
  readonly kind: 'worker' | 'main';
  render(input: DrawInput): void;
  /** Worker only: ms from posting a frame to the worker finishing it, for the last few frames. */
  latencies(): number[];
  dispose(): void;
}

/**
 * The worker renderer when the webview allows it, otherwise the main thread. A worker the CSP blocks
 * fails asynchronously, so the canvas is handed over only after the worker reports it is running.
 */
export async function createRenderer(canvas: HTMLCanvasElement, opts: { worker?: boolean } = {}): Promise<GraphRenderer> {
  if (opts.worker !== false && typeof canvas.transferControlToOffscreen === 'function') {
    const worker = await startWorker().catch(() => null);
    if (worker) return workerRenderer(canvas, worker);
  }
  return mainRenderer(canvas);
}

const WORKER_START_TIMEOUT_MS = 2000;

function startWorker(): Promise<Worker> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new RenderWorker();
    } catch (e) {
      reject(e);
      return;
    }
    const fail = (why: unknown) => {
      clearTimeout(timer);
      worker.terminate();
      reject(why);
    };
    const timer = setTimeout(() => fail(new Error('render worker did not start')), WORKER_START_TIMEOUT_MS);
    worker.onerror = fail;
    worker.onmessage = (e: MessageEvent<{ kind?: string }>) => {
      if (e.data?.kind !== 'ready') return;
      clearTimeout(timer);
      worker.onerror = null;
      resolve(worker);
    };
  });
}

function mainRenderer(canvas: HTMLCanvasElement): GraphRenderer {
  const ctx = canvas.getContext('2d')!;
  return {
    kind: 'main',
    render(d) {
      size(canvas, d);
      draw(ctx, d);
    },
    latencies: () => [],
    dispose() {},
  };
}

function workerRenderer(canvas: HTMLCanvasElement, worker: Worker): GraphRenderer {
  const offscreen = canvas.transferControlToOffscreen();
  worker.postMessage({ kind: 'init', canvas: offscreen } satisfies RenderMessage, [offscreen]);
  const recent: number[] = [];
  worker.onmessage = (e: MessageEvent<{ sentAt: number }>) => {
    recent.push(performance.now() - e.data.sentAt);
    if (recent.length > 300) recent.shift();
  };
  return {
    kind: 'worker',
    render(d) {
      const f = pack(d);
      worker.postMessage({ kind: 'frame', frame: f } satisfies RenderMessage, [f.present.buffer, f.lanes.buffer, f.flags.buffer, f.edgeStart.buffer, f.edges.buffer]);
    },
    latencies: () => recent.slice(),
    dispose: () => worker.terminate(),
  };
}
