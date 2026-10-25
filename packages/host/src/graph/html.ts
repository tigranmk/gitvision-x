/** The HTML shell every GitVision webview loads; no vscode import, so the Playwright harness uses it too. */

export interface WebviewHtmlOptions {
  /** `webview.cspSource`. */
  cspSource: string;
  nonce: string;
  /** URL of a file in the webview's bundle directory. */
  asset: (name: string) => string;
  /** Bundle name: loads `<name>.js` and `<name>.css`. */
  name: string;
  title: string;
}

/** Strict CSP: only our bundle runs; worker-src blob: is for the OffscreenCanvas renderer (D6). */
export function webviewCsp(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `style-src ${cspSource}`,
    `font-src ${cspSource}`,
    `img-src ${cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
    'worker-src blob:',
  ].join('; ');
}

export function webviewHtml(o: WebviewHtmlOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${webviewCsp(o.cspSource, o.nonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${o.asset(`${o.name}.css`)}">
<title>${o.title}</title>
</head>
<body>
<div id="app"></div>
<script type="module" nonce="${o.nonce}" src="${o.asset(`${o.name}.js`)}"></script>
</body>
</html>`;
}
