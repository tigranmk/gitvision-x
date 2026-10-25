import { describe, expect, it } from 'vitest';
import { FIRST_RETRY_MS, MAX_RETRY_MS, retryDelay } from './retry';

describe('retryDelay', () => {
  it('never retries outcomes that only change with the file or HEAD', () => {
    for (const code of ['not-tracked', 'binary', 'too-large']) expect(retryDelay(code, 1)).toBeNull();
  });

  it('retries a worker crash or git error, backing off up to a cap', () => {
    expect(retryDelay('worker-exit', 1)).toBe(FIRST_RETRY_MS);
    expect(retryDelay('git', 2)).toBe(FIRST_RETRY_MS * 2);
    expect(retryDelay('error', 3)).toBe(FIRST_RETRY_MS * 4);
    expect(retryDelay('worker-exit', 20)).toBe(MAX_RETRY_MS);
  });
});
