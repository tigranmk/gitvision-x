/**
 * Host-side client for the git engine: a lazily spawned pool of worker threads.
 * Requests with the same affinity key (the repo root) always go to the same worker,
 * so that worker holds the repo's in-memory index and blame cache.
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import {
  RpcEndpoint,
  RpcError,
  type EngineEvents,
  type EngineMethods,
  type EventMap,
  type RequestOptions,
  type Transport,
  type WireMessage,
  type NoMethods,
} from '@gvx/protocol';

export interface PoolOptions {
  workerPath: string;
  gitPath: string;
  size?: number;
  log?: (msg: string) => void;
  /** Diagnostic lines from the workers (every git run), prefixed with the worker's slot. */
  trace?: (msg: string) => void;
  validate?: (msg: unknown) => void;
}

type Rpc = RpcEndpoint<NoMethods, EngineMethods, EventMap, EngineEvents>;

interface Slot {
  worker: Worker | null;
  rpc: Rpc | null;
  init: Promise<void> | null;
}

export class WorkerPool {
  readonly size: number;
  private readonly slots: Slot[];
  private disposed = false;

  constructor(private readonly opts: PoolOptions) {
    this.size = opts.size ?? Math.min(4, Math.max(2, Math.floor(availableParallelism() / 2)));
    this.slots = Array.from({ length: this.size }, () => ({ worker: null, rpc: null, init: null }));
  }

  /** How many workers are running (they start on first use). */
  get started(): number {
    return this.slots.filter((s) => s.worker).length;
  }

  async request<M extends Exclude<keyof EngineMethods, 'engine.init'>>(
    method: M,
    params: EngineMethods[M]['params'],
    opts: RequestOptions<EngineMethods[M]['partial']> & { affinity?: string } = {},
  ): Promise<EngineMethods[M]['result']> {
    if (this.disposed) throw new RpcError('Worker pool disposed', 'disposed');
    const slot = this.slots[opts.affinity !== undefined ? this.slotFor(method, opts.affinity) : this.leastLoaded()]!;
    const rpc = this.ensure(slot);
    await slot.init;
    return rpc.request(method, params, opts);
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.slots) this.stop(s);
  }

  /**
   * Same repo → same worker per lane, so each worker keeps its repo state. Index work and blame
   * are separate lanes on different workers: a 100k-commit index load must not delay the ghost text.
   */
  private slotFor(method: string, affinity: string): number {
    const lane = method.startsWith('blame.') ? 1 : 0;
    return (hash(affinity) + lane) % this.size;
  }

  private leastLoaded(): number {
    let best = 0;
    let bestLoad = Infinity;
    this.slots.forEach((s, i) => {
      // Prefer running workers; spawning costs more than a short queue.
      const load = s.rpc ? s.rpc.inFlight : 2;
      if (load < bestLoad) [best, bestLoad] = [i, load];
    });
    return best;
  }

  private ensure(slot: Slot): Rpc {
    if (slot.rpc) return slot.rpc;
    const worker = new Worker(this.opts.workerPath);
    const transport: Transport = {
      post: (msg, transfer) => worker.postMessage(msg, transfer),
      onMessage: (handler) => {
        const h = (m: WireMessage) => handler(m);
        worker.on('message', h);
        return () => worker.off('message', h);
      },
    };
    const rpc: Rpc = new RpcEndpoint(transport, this.opts.validate);
    const n = this.slots.indexOf(slot);
    if (this.opts.trace) rpc.on('engine.trace', ({ msg }) => this.opts.trace?.(`worker ${n}: ${msg}`));
    const fail = (why: string) => {
      if (slot.worker !== worker) return;
      this.opts.log?.(`git worker stopped: ${why}`);
      rpc.failAll(new RpcError(`Git worker stopped: ${why}`, 'worker-exit'));
      this.stop(slot); // respawned on next request
    };
    worker.on('error', (e) => fail(e.message));
    worker.on('exit', (code) => fail(`exit code ${code}`));
    slot.worker = worker;
    slot.rpc = rpc;
    slot.init = rpc.request('engine.init', { gitPath: this.opts.gitPath }).then(
      ({ gitVersion }) => this.opts.log?.(`git worker ready (git ${gitVersion})`),
      (e) => {
        fail(`init failed: ${(e as Error).message}`);
        throw e;
      },
    );
    return rpc;
  }

  private stop(slot: Slot): void {
    const { worker, rpc } = slot;
    slot.worker = slot.rpc = slot.init = null;
    rpc?.dispose();
    void worker?.terminate();
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
