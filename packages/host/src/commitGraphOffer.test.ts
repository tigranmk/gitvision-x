import { expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));
const { shouldOffer, OFFER_MIN_COMMITS } = await import('./commitGraphOffer');

it('offers only for large repos without Bloom filters, unless declined or disabled', () => {
  const base = { commitCount: OFFER_MIN_COMMITS, status: { graph: true, bloom: false }, declined: false, enabled: true };
  expect(shouldOffer(base)).toBe(true);
  expect(shouldOffer({ ...base, status: { graph: false, bloom: false } })).toBe(true);
  expect(shouldOffer({ ...base, commitCount: OFFER_MIN_COMMITS - 1 })).toBe(false);
  expect(shouldOffer({ ...base, status: { graph: true, bloom: true } })).toBe(false);
  expect(shouldOffer({ ...base, declined: true })).toBe(false);
  expect(shouldOffer({ ...base, enabled: false })).toBe(false);
});
