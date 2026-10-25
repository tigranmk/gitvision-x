/**
 * When a failed blame is tried again. Failures that only change with the file or HEAD are kept (a HEAD
 * move clears the store anyway); anything else (a worker crash, a git error, a missing ignore-revs file
 * the user may fix) is retried on the next request after a delay that doubles with each failure, so a
 * file that always fails does not start git on every cursor move.
 */
const PERMANENT = ['not-tracked', 'binary', 'too-large'];
export const FIRST_RETRY_MS = 2_000;
export const MAX_RETRY_MS = 60_000;

/** Delay before the next attempt after `failures` consecutive failures, or null for never. */
export function retryDelay(code: string, failures: number): number | null {
  if (PERMANENT.includes(code)) return null;
  return Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, failures - 1), MAX_RETRY_MS);
}
