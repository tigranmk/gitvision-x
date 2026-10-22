/**
 * Streaming parser for
 *   git log -z --format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x1e
 * Records end with RS (0x1e); with -z git also separates records with NUL.
 */

/** The --format string the parser expects. */
export const LOG_FORMAT = '--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x1e';

export interface LogRecord {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  /** Unix seconds. */
  time: number;
  subject: string;
}

export class LogStreamParser {
  private readonly decoder = new TextDecoder('utf-8');
  private rest = '';

  constructor(private readonly onRecord: (r: LogRecord) => void) {}

  push(chunk: Uint8Array): void {
    const text = this.rest + this.decoder.decode(chunk, { stream: true });
    let start = 0;
    for (let end = text.indexOf('\x1e', start); end !== -1; end = text.indexOf('\x1e', start)) {
      this.emit(text, start, end);
      start = end + 1;
    }
    this.rest = text.slice(start);
  }

  end(): void {
    const text = this.rest + this.decoder.decode();
    this.rest = '';
    if (text.replace(/[\0\n]/g, '').length > 0) throw new Error('git log output ended mid-record');
  }

  private emit(text: string, start: number, end: number): void {
    // Skip the NUL/newline separator that precedes every record after the first.
    while (start < end && (text.charCodeAt(start) === 0 || text.charCodeAt(start) === 10)) start++;
    const f = text.slice(start, end).split('\0');
    if (f.length < 6) throw new Error(`Malformed git log record: ${JSON.stringify(f[0])}`);
    const parents = f[1] ? f[1].split(' ') : [];
    // %s cannot contain NUL, so extra fields can only come from a stray NUL; join them back.
    const subject = f.length === 6 ? f[5]! : f.slice(5).join('\0');
    this.onRecord({ sha: f[0]!, parents, author: f[2]!, email: f[3]!, time: Number(f[4]), subject });
  }
}
