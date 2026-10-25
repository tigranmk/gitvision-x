import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

describe('PerfTelemetry', () => {
  it('is off without a built-in connection string: nothing is recorded or sent', async () => {
    const { PerfTelemetry } = await import('./perfTelemetry');
    const t = PerfTelemetry.create();
    expect(t.enabled).toBe(false);
    t.record('blameCold', 12);
    expect(t.summary()).toEqual({});
  });

  it('sends counts and percentiles only: no strings, no paths', async () => {
    const { PerfTelemetry } = await import('./perfTelemetry');
    const sent: unknown[] = [];
    const t = PerfTelemetry.create();
    // Stand in for an enabled build.
    (t as unknown as { reporter: unknown }).reporter = { sendTelemetryEvent: (...a: unknown[]) => sent.push(a), dispose() {} };
    for (const ms of [10, 12, 14, 100]) t.record('blameCold', ms);
    t.record('activation', 0.4);
    t.flush();
    expect(sent).toEqual([['perf', {}, { 'blameCold.count': 4, 'blameCold.p50': 14, 'blameCold.p95': 100, 'activation.count': 1, 'activation.p50': 0.4, 'activation.p95': 0.4 }]]);
    t.flush();
    expect(sent).toHaveLength(1); // nothing new: nothing sent
  });
});
