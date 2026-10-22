/* eslint-disable @typescript-eslint/no-explicit-any -- method/event maps are matched structurally; `any` keeps them variance-free */
/**
 * One request/response + push channel used for host ↔ worker and host ↔ webview.
 * Requests carry an id for correlation and can be cancelled ({ kind: 'cancel', id }),
 * so fast scrolling can abort stale log pages.
 */

export type WireError = { message: string; code?: string };

export type WireMessage =
  | { kind: 'req'; id: number; method: string; params: unknown }
  | { kind: 'res'; id: number; ok: true; result: unknown }
  | { kind: 'res'; id: number; ok: false; error: WireError }
  | { kind: 'part'; id: number; data: unknown }
  | { kind: 'cancel'; id: number }
  | { kind: 'push'; event: string; data: unknown };

export interface Transport {
  post(msg: WireMessage, transfer?: ArrayBuffer[]): void;
  /** Returns an unsubscribe function. */
  onMessage(handler: (msg: WireMessage) => void): () => void;
}

/** params → result, with optional streamed partial results. */
export interface MethodSpec<P = unknown, R = unknown, Part = never> {
  params: P;
  result: R;
  partial: Part;
}
export type MethodMap = { [method: string]: MethodSpec<any, any, any> };
export type EventMap = { [event: string]: unknown };
/** For an endpoint that serves (or calls) nothing. */
export type NoMethods = Record<never, never>;

/** Payload rule: anything over 64 KB goes as a transferable buffer, never as JSON. */
export const TRANSFER_THRESHOLD = 64 * 1024;

const TRANSFER = Symbol('transfer');
export interface WithTransfer<T> {
  [TRANSFER]: ArrayBuffer[];
  value: T;
}
/** Wrap a handler result (or partial) to move the listed buffers instead of copying them. */
export function withTransfer<T>(value: T, buffers: ArrayBuffer[]): WithTransfer<T> {
  return { [TRANSFER]: buffers, value };
}
function unwrap(v: unknown): { value: unknown; transfer?: ArrayBuffer[] } {
  if (v && typeof v === 'object' && TRANSFER in v) {
    const w = v as WithTransfer<unknown>;
    return { value: w.value, transfer: w[TRANSFER] };
  }
  return { value: v };
}

export class RpcError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'RpcError';
  }
}
export class CancelledError extends RpcError {
  constructor() {
    super('Request cancelled', 'cancelled');
    this.name = 'CancelledError';
  }
}
export const isCancelled = (e: unknown): boolean => e instanceof RpcError && e.code === 'cancelled';

export interface HandlerContext<Part> {
  signal: AbortSignal;
  partial(data: Part | WithTransfer<Part>): void;
}
export type Handler<S extends MethodSpec<any, any, any>> = (
  params: S['params'],
  ctx: HandlerContext<S['partial']>,
) => Promise<S['result'] | WithTransfer<S['result']>> | S['result'] | WithTransfer<S['result']>;

export interface RequestOptions<Part> {
  signal?: AbortSignal;
  onPartial?: (data: Part) => void;
}

type Pending = {
  resolve(v: unknown): void;
  reject(e: unknown): void;
  onPartial?: (data: unknown) => void;
  cleanup(): void;
};

/**
 * Bidirectional endpoint. `Local` = methods this side serves, `Remote` = methods it calls.
 * `PushOut`/`PushIn` = fire-and-forget events.
 */
export class RpcEndpoint<
  Local extends MethodMap,
  Remote extends MethodMap,
  PushOut extends EventMap = EventMap,
  PushIn extends EventMap = EventMap,
> {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly running = new Map<number, AbortController>();
  private readonly handlers = new Map<string, Handler<any>>();
  private readonly listeners = new Map<string, Set<(data: any) => void>>();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(
    private readonly transport: Transport,
    private readonly validate?: (msg: unknown) => void,
  ) {
    this.unsubscribe = transport.onMessage((m) => this.receive(m));
  }

  handle<M extends keyof Local & string>(method: M, handler: Handler<Local[M]>): void {
    this.handlers.set(method, handler);
  }

  request<M extends keyof Remote & string>(
    method: M,
    params: Remote[M]['params'],
    opts: RequestOptions<Remote[M]['partial']> = {},
  ): Promise<Remote[M]['result']> {
    if (this.disposed) return Promise.reject(new RpcError('Endpoint disposed', 'disposed'));
    const { signal, onPartial } = opts;
    if (signal?.aborted) return Promise.reject(new CancelledError());
    const id = this.nextId++;
    const { value, transfer } = unwrap(params);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.get(id)?.cleanup();
        this.transport.post({ kind: 'cancel', id });
        reject(new CancelledError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        onPartial: onPartial as ((d: unknown) => void) | undefined,
        cleanup: () => {
          this.pending.delete(id);
          signal?.removeEventListener('abort', onAbort);
        },
      });
      this.transport.post({ kind: 'req', id, method, params: value }, transfer);
    });
  }

  emit<E extends keyof PushOut & string>(event: E, data: PushOut[E]): void {
    if (this.disposed) return;
    const { value, transfer } = unwrap(data);
    this.transport.post({ kind: 'push', event, data: value }, transfer);
  }

  on<E extends keyof PushIn & string>(event: E, listener: (data: PushIn[E]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Number of requests awaiting a response (used for least-loaded routing). */
  get inFlight(): number {
    return this.pending.size;
  }

  /** Rejects every pending request, e.g. when the worker behind the transport died. */
  failAll(error: RpcError): void {
    for (const p of [...this.pending.values()]) {
      p.cleanup();
      p.reject(error);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    for (const c of this.running.values()) c.abort();
    this.running.clear();
    this.failAll(new RpcError('Endpoint disposed', 'disposed'));
  }

  private receive(msg: WireMessage): void {
    if (this.disposed) return;
    if (this.validate) {
      try {
        this.validate(msg);
      } catch (e) {
        console.error('[gitvision] dropped invalid message', e);
        return;
      }
    }
    switch (msg.kind) {
      case 'req':
        void this.serve(msg.id, msg.method, msg.params);
        return;
      case 'cancel':
        this.running.get(msg.id)?.abort();
        this.running.delete(msg.id);
        return;
      case 'part':
        this.pending.get(msg.id)?.onPartial?.(msg.data);
        return;
      case 'res': {
        const p = this.pending.get(msg.id);
        if (!p) return; // cancelled or unknown
        p.cleanup();
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new RpcError(msg.error.message, msg.error.code));
        return;
      }
      case 'push':
        for (const l of this.listeners.get(msg.event) ?? []) l(msg.data);
        return;
    }
  }

  private async serve(id: number, method: string, params: unknown): Promise<void> {
    const handler = this.handlers.get(method);
    if (!handler) {
      this.transport.post({ kind: 'res', id, ok: false, error: { message: `Unknown method ${method}`, code: 'unknown-method' } });
      return;
    }
    const controller = new AbortController();
    this.running.set(id, controller);
    const ctx: HandlerContext<unknown> = {
      signal: controller.signal,
      partial: (data) => {
        if (controller.signal.aborted) return;
        const { value, transfer } = unwrap(data);
        this.transport.post({ kind: 'part', id, data: value }, transfer);
      },
    };
    try {
      const out = await handler(params, ctx);
      if (controller.signal.aborted) return;
      const { value, transfer } = unwrap(out);
      this.transport.post({ kind: 'res', id, ok: true, result: value }, transfer);
    } catch (e) {
      if (controller.signal.aborted) return;
      const err = e as { message?: string; code?: unknown };
      this.transport.post({
        kind: 'res',
        id,
        ok: false,
        error: { message: err?.message ?? String(e), code: typeof err?.code === 'string' ? err.code : undefined },
      });
    } finally {
      this.running.delete(id);
    }
  }
}
