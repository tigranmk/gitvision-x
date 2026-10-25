/** Relative dates ("3 days ago"), shared by the host's blame text and the webviews. */

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86400],
  ['month', 30 * 86400],
  ['week', 7 * 86400],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

export function relativeTime(thenSec: number, nowSec: number, locale = 'en'): string {
  const diff = thenSec - nowSec;
  const abs = Math.abs(diff);
  if (abs < 45) return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(0, 'second');
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
  const sign = diff < 0 ? -1 : 1;
  // Round the magnitude: Math.round(-1.5) is -1, which would turn 90 s ago into "1 minute ago".
  for (const [unit, sec] of UNITS) {
    if (abs >= sec) return fmt.format(sign * Math.round(abs / sec), unit);
  }
  return fmt.format(sign, 'minute');
}
