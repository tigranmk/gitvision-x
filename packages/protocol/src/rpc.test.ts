import { describe, expect, it } from 'vitest';
import { CancelledError, RpcEndpoint, RpcError, withTransfer, type MethodSpec, type Transport, type WireMessage } from './rpc';
import { validateWire } from './schemas';

type Methods = {
  echo: MethodSpec<{ v: number }, number>;
  slow: MethodSpec<null, string, number>;
  fail: MethodSpec<null, never>;
  bytes: MethodSpec<null, Uint8Array>;
};

/** Two endpoints joined by an async in-memory channel that records transfers. */
function pair() {
  const transfers: ArrayBuffer[][] = [];
  const make = (): Transport & { deliver(m: WireMessage): void; peer?: { deliver(m: WireMessage): void } } => {
    const handlers = new Set<(m: WireMessage) => void>();
    const t = {
      peer: undefined as undefined | { deliver(m: WireMessage): void },
      post(m: WireMessage, transfer?: ArrayBuffer[]) {
        if (transfer) transfers.push(transfer);
        const copy = structuredClone(m);
        queueMicrotask(() => t.peer!.deliver(copy));
      },
      onMessage(h: (m: WireMessage) => void) {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      deliver(m: WireMessage) {
        for (const h of handlers) h(m);
      },
    };
    return t;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  const server = new RpcEndpoint<Methods, Record<never, never>>(b, validateWire);
  const client = new RpcEndpoint<Record<never, never>, Methods, Record<string, unknown>, { ping: string }>(a, validateWire);
  return { server, client, transfers };
}

describe('RpcEndpoint', () => {
  it('correlates concurrent requests by id', async () => {
    const { server, client } = pair();
    server.handle('echo', async ({ v }) => {
      await new Promise((r) => setTimeout(r, 10 - v));
      return v * 2;
    });
    await expect(Promise.all([1, 2, 3].map((v) => client.request('echo', { v })))).resolves.toEqual([2, 4, 6]);
  });

  it('streams partial results before the response', async () => {
    const { server, client } = pair();
    server.handle('slow', async (_p, { partial }) => {
      partial(1);
      partial(2);
      return 'done';
    });
    const parts: number[] = [];
    await expect(client.request('slow', null, { onPartial: (p) => parts.push(p) })).resolves.toBe('done');
    expect(parts).toEqual([1, 2]);
  });

  it('cancellation rejects the caller and aborts the handler', async () => {
    const { server, client } = pair();
    let aborted!: Promise<void>;
    server.handle('slow', (_p, { signal }) => {
      aborted = new Promise((r) => signal.addEventListener('abort', () => r()));
      return new Promise(() => {});
    });
    const ctl = new AbortController();
    const req = client.request('slow', null, { signal: ctl.signal });
    await new Promise((r) => setTimeout(r, 5));
    ctl.abort();
    await expect(req).rejects.toBeInstanceOf(CancelledError);
    await aborted;
    expect(client.inFlight).toBe(0);
  });

  it('propagates handler errors with their code', async () => {
    const { server, client } = pair();
    server.handle('fail', () => {
      throw Object.assign(new Error('nope'), { code: 'not-tracked' });
    });
    await expect(client.request('fail', null)).rejects.toMatchObject({ message: 'nope', code: 'not-tracked' });
  });

  it('rejects unknown methods', async () => {
    const { client } = pair();
    await expect(client.request('echo', { v: 1 })).rejects.toMatchObject({ code: 'unknown-method' });
  });

  it('passes transfer lists to the transport', async () => {
    const { server, client, transfers } = pair();
    const data = new Uint8Array([1, 2, 3]);
    server.handle('bytes', () => withTransfer(data, [data.buffer]));
    await expect(client.request('bytes', null)).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(transfers[0]?.[0]).toBe(data.buffer);
  });

  it('delivers push events and failAll rejects pending requests', async () => {
    const { server, client } = pair();
    const got: string[] = [];
    client.on('ping', (d) => got.push(d));
    (server as unknown as RpcEndpoint<Record<never, never>, Record<never, never>, { ping: string }>).emit('ping', 'hi');
    await new Promise((r) => setTimeout(r, 1));
    expect(got).toEqual(['hi']);

    server.handle('slow', () => new Promise(() => {}));
    const req = client.request('slow', null);
    client.failAll(new RpcError('gone', 'worker-exit'));
    await expect(req).rejects.toMatchObject({ code: 'worker-exit' });
  });

  it('dev validation rejects malformed wire messages', () => {
    expect(() => validateWire({ kind: 'req', id: 0, method: 'x', params: null })).toThrow();
    expect(() => validateWire({ kind: 'cancel', id: 3 })).not.toThrow();
  });
});
