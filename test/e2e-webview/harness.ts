/**
 * Loads a built webview (dist/webviews/<name>) in Playwright's Chromium as VS Code would: the same HTML
 * and CSP, theme variables on <html>, and acquireVsCodeApi() bridged to a host RpcEndpoint in this
 * process. The host side serves graph pages from a real WorkerPool over a fixture repo.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { WorkerPool } from '@gvx/git-engine';
import {
  RpcEndpoint,
  type EventMap,
  type GraphHostEvents,
  type GraphHostMethods,
  type GraphState,
  type NoMethods,
  type WireMessage,
} from '@gvx/protocol';
import { webviewHtml } from '../../packages/host/src/graph/html';
import { registerGraphMethods } from '../../packages/host/src/graph/methods';

const ROOT = path.resolve(__dirname, '../..');
export const FIXTURES = path.join(ROOT, 'test/fixtures/repos');
const ORIGIN = 'https://gvx.test';

type HostRpc = RpcEndpoint<GraphHostMethods, NoMethods, GraphHostEvents, EventMap>;

/** VS Code's Dark Modern values for the variables the tokens alias. */
export const DARK_THEME: Record<string, string> = {
  '--vscode-font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  '--vscode-font-size': '13px',
  '--vscode-editor-font-family': 'Menlo, Monaco, "Courier New", monospace',
  '--vscode-foreground': '#cccccc',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-sideBar-background': '#181818',
  '--vscode-editor-background': '#1f1f1f',
  '--vscode-editorWidget-background': '#202020',
  '--vscode-widget-border': '#313131',
  '--vscode-focusBorder': '#0078d4',
  '--vscode-list-activeSelectionBackground': '#04395e',
  '--vscode-list-activeSelectionForeground': '#ffffff',
  '--vscode-list-hoverBackground': '#2a2d2e',
  '--vscode-editor-findMatchHighlightBackground': '#ea5c0055',
  '--vscode-charts-blue': '#3794ff',
  '--vscode-charts-green': '#89d185',
  '--vscode-charts-orange': '#d18616',
  '--vscode-charts-purple': '#b180d7',
  '--vscode-charts-red': '#f14c4c',
  '--vscode-charts-yellow': '#cca700',
  '--vscode-terminal-ansiCyan': '#11a8cd',
  '--vscode-terminal-ansiMagenta': '#bc3fbc',
  '--vscode-gitDecoration-addedResourceForeground': '#81b88b',
  '--vscode-gitDecoration-deletedResourceForeground': '#c74e39',
  '--vscode-gitDecoration-modifiedResourceForeground': '#e2c08d',
  '--vscode-textLink-foreground': '#4daafc',
  '--vscode-diffEditor-insertedLineBackground': '#9bb95533',
  '--vscode-diffEditor-removedLineBackground': '#ff000033',
};

export interface Harness {
  page: Page;
  host: HostRpc;
  state: GraphState;
  root: string;
  pool: WorkerPool;
  /** Diff editors the webview asked the host to open. */
  diffsOpened: GraphHostMethods['graph.openDiff']['params'][];
  /** Text the webview asked the host to copy. */
  clipboard: string[];
  /** Repo-relative paths the fake host reports as open in editors (mutable). */
  openFiles: string[];
  /** Wire messages the webview sent, by method (requests only). */
  requests: { method: string; params: unknown }[];
  cspViolations: string[];
  /** Uncaught errors in the page; dispose() fails the test if there are any. */
  pageErrors: string[];
  dispose(): Promise<void>;
}

export interface OpenOptions {
  theme?: Record<string, string>;
  bodyClass?: string;
  /** Rewrites the CSP the page is served with (to test fallbacks). */
  csp?: (csp: string) => string;
}

export async function openGraph(page: Page, fixture: string, opts: OpenOptions = {}): Promise<Harness> {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: path.join(FIXTURES, fixture), encoding: 'utf8' }).trim();
  const storage = mkdtempSync(path.join(tmpdir(), 'gvx-e2e-'));
  const pool = new WorkerPool({ workerPath: path.join(ROOT, 'dist/worker.js'), gitPath: 'git' });
  const stats = await pool.request('index.sync', { root, storageDir: storage }, { affinity: root });
  const state: GraphState = { root, total: stats.commitCount, userEmail: 'dev0@example.com', sync: null, activeFile: null };
  const requests: Harness['requests'] = [];
  const cspViolations: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  let deliver: ((msg: WireMessage) => void) | null = null;
  const host: HostRpc = new RpcEndpoint({
    post: (msg) => void page.evaluate((m) => (window as unknown as { __gvxDeliver(m: unknown): void }).__gvxDeliver(m), encode(msg)).catch(() => {}),
    onMessage: (handler) => {
      deliver = handler;
      return () => (deliver = null);
    },
  });
  const clipboard: string[] = [];
  const diffsOpened: Harness['diffsOpened'] = [];
  const openFiles: string[] = [];
  registerGraphMethods(host, {
    pool,
    state: () => state,
    shown: () => root,
    openFiles: () => openFiles,
    writeClipboard: async (text) => void clipboard.push(text),
    openDiff: async (a) => void diffsOpened.push(a),
  });

  await page.exposeFunction('__gvxToHost', (m: unknown) => {
    const msg = decode(m) as WireMessage;
    if (msg.kind === 'req') requests.push({ method: msg.method, params: msg.params });
    deliver?.(msg);
  });
  await page.exposeFunction('__gvxCsp', (v: string) => cspViolations.push(v));
  await page.addInitScript(
    ({ theme, bodyClass }) => {
      const w = window as unknown as Record<string, unknown>;
      // Same codec as encode()/decode() below: typed arrays cross the bridge as tagged arrays.
      const enc = (v: unknown): unknown => {
        if (ArrayBuffer.isView(v)) return { __ta: v.constructor.name, v: Array.from(v as unknown as ArrayLike<number>) };
        if (Array.isArray(v)) return v.map(enc);
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]));
        return v;
      };
      const dec = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(dec);
        if (v && typeof v === 'object') {
          const o = v as { __ta?: string; v?: number[] };
          if (o.__ta) return new (w[o.__ta] as new (a: number[]) => unknown)(o.v!);
          return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]));
        }
        return v;
      };
      let saved: unknown;
      w.acquireVsCodeApi = () => ({
        postMessage: (m: unknown) => (w.__gvxToHost as (m: unknown) => void)(enc(m)),
        getState: () => saved,
        setState: (s: unknown) => (saved = s),
      });
      w.__gvxDeliver = (m: unknown) => {
        w.__gvxDeliveredAt = performance.now();
        window.dispatchEvent(new MessageEvent('message', { data: dec(m) }));
      };
      document.addEventListener('securitypolicyviolation', (e) =>
        (w.__gvxCsp as (v: string) => void)(`${e.violatedDirective}: ${e.blockedURI}`),
      );
      // As in VS Code, theme variables and the body class are in place before any webview script runs
      // ('interactive' comes before module scripts execute).
      document.addEventListener('readystatechange', () => {
        if (document.readyState !== 'interactive') return;
        for (const [k, v] of Object.entries(theme)) document.documentElement.style.setProperty(k, v);
        document.body.classList.add(bodyClass);
      });
    },
    { theme: opts.theme ?? DARK_THEME, bodyClass: opts.bodyClass ?? 'vscode-dark' },
  );

  const bundle = path.join(ROOT, 'dist/webviews/graph');
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      let html = webviewHtml({ cspSource: ORIGIN, nonce: 'e2e-nonce', asset: (n) => `${ORIGIN}/${n}`, name: 'graph', title: 'Git Graph' });
      if (opts.csp) html = html.replace(/content="([^"]*)"/, (_, c: string) => `content="${opts.csp!(c)}"`);
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    const file = path.join(bundle, path.basename(url.pathname));
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.ttf') ? 'font/ttf' : 'application/octet-stream';
    return route.fulfill({ contentType: type, body: readFileSync(file) });
  });
  await page.goto(`${ORIGIN}/`);

  return {
    page,
    host,
    state,
    root,
    pool,
    clipboard,
    diffsOpened,
    openFiles,
    requests,
    cspViolations,
    pageErrors,
    async dispose() {
      host.dispose();
      pool.dispose();
      rmSync(storage, { recursive: true, force: true });
      if (pageErrors.length) throw new Error(`Uncaught errors in the webview:\n${pageErrors.join('\n')}`);
    },
  };
}

/**
 * RGB of the screen pixel at CSS (x, y), from a real screenshot: works whichever thread draws the
 * canvas (a canvas transferred to a worker cannot be read back with getContext).
 */
export async function pixelAt(page: Page, x: number, y: number): Promise<number[]> {
  const png = (await page.screenshot({ clip: { x, y, width: 1, height: 1 } })).toString('base64');
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
  }, png);
}

/**
 * Starts watching for a condition in the page; the returned function resolves with the ms from the last
 * host message's arrival in the page to the first frame the condition held (measured in the page).
 */
export async function timeFromDelivery(page: Page, condition: string): Promise<() => Promise<number>> {
  await page.evaluate((cond) => {
    const w = window as unknown as Record<string, unknown>;
    const test = new Function(`return (${cond});`) as () => boolean;
    w.__gvxWatch = new Promise<number>((resolve) => {
      const tick = () => (test() ? resolve(performance.now() - (w.__gvxDeliveredAt as number)) : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
  }, condition);
  return () => page.evaluate(() => (window as unknown as { __gvxWatch: Promise<number> }).__gvxWatch);
}

function encode(v: unknown): unknown {
  if (ArrayBuffer.isView(v)) return { __ta: v.constructor.name, v: Array.from(v as unknown as ArrayLike<number>) };
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
  return v;
}

function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') {
    const o = v as { __ta?: string; v?: number[] };
    if (o.__ta) return new (globalThis as unknown as Record<string, new (a: number[]) => unknown>)[o.__ta]!(o.v!);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]));
  }
  return v;
}
