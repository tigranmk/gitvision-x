/**
 * Performance telemetry (spec: perf timings only, no paths). Off unless the build carries an Application
 * Insights connection string (GVX_TELEMETRY_CONNECTION at build time); then it also follows VS Code's
 * telemetry.telemetryLevel through @vscode/extension-telemetry. Timings are aggregated in memory and sent
 * as one event per period: counts and percentiles per metric, nothing that names a file, repo or person.
 */
import * as vscode from 'vscode';

export type PerfMetric = 'activation' | 'blameCold' | 'graphSync' | 'timeTravelStep' | 'indexSync';

const FLUSH_MS = 30 * 60 * 1000;
const MAX_SAMPLES = 2000;

interface Reporter {
  sendTelemetryEvent(name: string, props?: Record<string, string>, measurements?: Record<string, number>): void;
  dispose(): Promise<unknown> | void;
}

export class PerfTelemetry implements vscode.Disposable {
  private readonly samples = new Map<PerfMetric, number[]>();
  private reporter: Reporter | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;

  /** Starts sending only when a connection string was built in; otherwise every call is a no-op. */
  static create(): PerfTelemetry {
    const t = new PerfTelemetry();
    // The build constant is tested directly, so a build without a connection string drops this branch and
    // never bundles the reporter.
    if (__TELEMETRY_CONNECTION__) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { TelemetryReporter } = require('@vscode/extension-telemetry') as { TelemetryReporter: new (c: string) => Reporter };
      t.reporter = new TelemetryReporter(__TELEMETRY_CONNECTION__);
      t.timer = setInterval(() => t.flush(), FLUSH_MS);
    }
    return t;
  }

  get enabled(): boolean {
    return !!this.reporter;
  }

  record(metric: PerfMetric, ms: number): void {
    if (!this.reporter || !Number.isFinite(ms)) return;
    let list = this.samples.get(metric);
    if (!list) this.samples.set(metric, (list = []));
    if (list.length < MAX_SAMPLES) list.push(ms);
  }

  /** The event that would be sent now: per metric, its count, median and p95 (ms). Exported for tests. */
  summary(): Record<string, number> {
    const m: Record<string, number> = {};
    for (const [metric, list] of this.samples) {
      if (!list.length) continue;
      const s = [...list].sort((a, b) => a - b);
      m[`${metric}.count`] = s.length;
      m[`${metric}.p50`] = Math.round(s[Math.floor(s.length / 2)]! * 10) / 10;
      m[`${metric}.p95`] = Math.round(s[Math.ceil(s.length * 0.95) - 1]! * 10) / 10;
    }
    return m;
  }

  flush(): void {
    const m = this.summary();
    this.samples.clear();
    if (this.reporter && Object.keys(m).length) this.reporter.sendTelemetryEvent('perf', {}, m);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.flush();
    void this.reporter?.dispose();
  }
}
