/** The graph webview's end of the host channel. */
import type { GraphHostEvents, GraphHostMethods } from '@gvx/protocol';
import { connect as connectShared, vscodeApi as sharedApi } from '@gvx/webview-shared';

export const vscodeApi = sharedApi();
export const connect = () => connectShared<GraphHostMethods, GraphHostEvents>();
export type HostRpc = ReturnType<typeof connect>;
