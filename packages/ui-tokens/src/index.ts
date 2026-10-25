/**
 * Canvas cannot read CSS variables per draw call: read the tokens once, and again when VS Code
 * switches theme (it swaps vscode-light / vscode-dark / vscode-high-contrast on <body class>).
 */
export interface CanvasTheme {
  /** --gvx-lane-1 … 8. */
  lanes: string[];
  surface: string;
  text: string;
  muted: string;
  selection: string;
  hover: string;
  lineSync: string;
  focus: string;
  head: string;
  conflict: string;
  /** Set in high-contrast themes: nodes and chips get a 1 px outline in this colour. */
  contrastBorder: string | null;
  highContrast: boolean;
  /** 0 under prefers-reduced-motion. */
  motionMs: number;
}

export const LANE_TOKENS = Array.from({ length: 8 }, (_, i) => `--gvx-lane-${i + 1}`);

export function readTheme(root: HTMLElement = document.documentElement, body: HTMLElement = document.body): CanvasTheme {
  const css = getComputedStyle(root);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const highContrast = body.classList.contains('vscode-high-contrast') || body.classList.contains('vscode-high-contrast-light');
  const border = v('--gvx-contrast-border', 'transparent');
  return {
    lanes: LANE_TOKENS.map((t, i) => v(t, FALLBACK_LANES[i]!)),
    surface: v('--gvx-surface', '#1e1e1e'),
    text: v('--gvx-text', '#cccccc'),
    muted: v('--gvx-text-muted', '#999999'),
    selection: v('--gvx-selection', '#04395e'),
    hover: v('--gvx-hover', '#2a2d2e'),
    lineSync: v('--gvx-line-sync', '#ea5c0055'),
    focus: v('--gvx-focus', '#007fd4'),
    head: v('--gvx-head', FALLBACK_LANES[0]!),
    conflict: v('--gvx-conflict', '#e4676b'),
    contrastBorder: highContrast && border !== 'transparent' ? border : null,
    highContrast,
    motionMs: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 120,
  };
}

/** Calls `onChange` with a fresh theme whenever the body's theme class or the motion preference changes. */
export function watchTheme(onChange: (t: CanvasTheme) => void): () => void {
  const fire = () => onChange(readTheme());
  const mo = new MutationObserver(fire);
  mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  mq.addEventListener('change', fire);
  return () => {
    mo.disconnect();
    mq.removeEventListener('change', fire);
  };
}

/** VS Code's default dark chart colours, used only if a variable is missing. */
const FALLBACK_LANES = ['#3794ff', '#89d185', '#d18616', '#b180d7', '#f14c4c', '#cca700', '#29b8db', '#d670d6'];
