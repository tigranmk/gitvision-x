/** A webview's end of its host channel: an RpcEndpoint over acquireVsCodeApi().postMessage. */
import { RpcEndpoint, type EventMap, type MethodMap, type NoMethods, type Transport } from '@gvx/protocol';

export interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;
/** acquireVsCodeApi() may only be called once per webview. */
export function vscodeApi(): VsCodeApi {
  return (api ??= acquireVsCodeApi());
}

export function connect<Remote extends MethodMap, PushIn extends EventMap>(): RpcEndpoint<NoMethods, Remote, EventMap, PushIn> {
  const transport: Transport = {
    post: (msg) => vscodeApi().postMessage(msg),
    onMessage: (handler) => {
      const listener = (e: MessageEvent) => handler(e.data);
      window.addEventListener('message', listener);
      return () => window.removeEventListener('message', listener);
    },
  };
  return new RpcEndpoint(transport);
}
