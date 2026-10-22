import { describe, expect, it } from 'vitest';
import { LogStreamParser, type LogRecord } from './logParser';

const rec = (sha: string, parents: string, subject: string) => `${sha}\0${parents}\0Ann Ö\0ann@x.io\0${1700000000}\0${subject}\x1e`;
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const stream = [rec(C, `${A} ${B}`, 'Merge “feature” 🚀'), rec(B, A, 'tab\there'), rec(A, '', 'root')].join('\0');

function parse(chunks: Uint8Array[]): LogRecord[] {
  const out: LogRecord[] = [];
  const p = new LogStreamParser((r) => out.push(r));
  chunks.forEach((c) => p.push(c));
  p.end();
  return out;
}

describe('LogStreamParser', () => {
  const bytes = new TextEncoder().encode(stream);

  it('parses merges, roots and non-ASCII subjects', () => {
    const r = parse([bytes]);
    expect(r.map((x) => x.sha)).toEqual([C, B, A]);
    expect(r[0]).toMatchObject({ parents: [A, B], author: 'Ann Ö', email: 'ann@x.io', time: 1700000000, subject: 'Merge “feature” 🚀' });
    expect(r[1]!.subject).toBe('tab\there');
    expect(r[2]!.parents).toEqual([]);
  });

  it('gives the same result for every chunk split point, including mid-UTF-8', () => {
    const whole = parse([bytes]);
    for (let i = 1; i < bytes.length; i++) {
      expect(parse([bytes.subarray(0, i), bytes.subarray(i)])).toEqual(whole);
    }
  });

  it('rejects truncated output', () => {
    expect(() => parse([bytes.subarray(0, 50)])).toThrow(/mid-record/);
  });
});
