/** The webview's end of the host channel, over acquireVsCodeApi().postMessage. */
import { RpcEndpoint, type EventMap, type GraphHostEvents, type GraphHostMethods, type NoMethods, type Transport } from '@gvx/protocol';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

export type HostRpc = RpcEndpoint<NoMethods, GraphHostMethods, EventMap, GraphHostEvents>;

export const vscodeApi: VsCodeApi = acquireVsCodeApi();

export function connect(): HostRpc {
  const transport: Transport = {
    post: (msg) => vscodeApi.postMessage(msg),
    onMessage: (handler) => {
      const listener = (e: MessageEvent) => handler(e.data);
      window.addEventListener('message', listener);
      return () => window.removeEventListener('message', listener);
    },
  };
  return new RpcEndpoint(transport);
}
