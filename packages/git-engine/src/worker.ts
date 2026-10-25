/** worker_threads entry: bundled to dist/worker.js. */
import { parentPort } from 'node:worker_threads';
import { RpcEndpoint, type EngineEvents, type EngineMethods, type EventMap, type Transport, type WireMessage, type NoMethods } from '@gvx/protocol';
import { registerEngine } from './engine';

if (!parentPort) throw new Error('worker.js must run in a worker thread');
const port = parentPort;

const transport: Transport = {
  post: (msg, transfer) => port.postMessage(msg, transfer),
  onMessage: (handler) => {
    const h = (m: WireMessage) => handler(m);
    port.on('message', h);
    return () => port.off('message', h);
  },
};

registerEngine(new RpcEndpoint<EngineMethods, NoMethods, EngineEvents, EventMap>(transport));
