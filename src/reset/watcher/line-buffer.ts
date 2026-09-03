export const MAX_JSONL_LINE_BYTES = 2 * 1024 * 1024;

export interface CompleteLine {
  text: string;
  consumedBytes: number;
}

export interface LineBufferResult {
  lines: CompleteLine[];
  oversizeLines: number;
  discardedBytes: number;
}

export class LineBuffer {
  private buffered: string;
  private discardingOversizeLine: boolean;
  private readonly maxLineBytes: number;

  constructor(options: { trailingPartialLine?: string; discardingOversizeLine?: boolean; maxLineBytes?: number } = {}) {
    this.buffered = options.trailingPartialLine ?? '';
    this.discardingOversizeLine = options.discardingOversizeLine ?? false;
    this.maxLineBytes = options.maxLineBytes ?? MAX_JSONL_LINE_BYTES;
  }

  push(chunk: string): LineBufferResult {
    let input = chunk;
    const lines: CompleteLine[] = [];
    let oversizeLines = 0;
    let discardedBytes = 0;

    if (this.discardingOversizeLine) {
      const newline = input.indexOf('\n');
      if (newline === -1) {
        discardedBytes += Buffer.byteLength(input, 'utf8');
        return { lines, oversizeLines, discardedBytes };
      }
      discardedBytes += Buffer.byteLength(input.slice(0, newline + 1), 'utf8');
      input = input.slice(newline + 1);
      this.discardingOversizeLine = false;
    }

    this.buffered += input;
    while (true) {
      const newline = this.buffered.indexOf('\n');
      if (newline === -1) {
        break;
      }
      const rawLine = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      const consumedBytes = Buffer.byteLength(rawLine, 'utf8') + 1;
      if (Buffer.byteLength(rawLine, 'utf8') > this.maxLineBytes) {
        oversizeLines += 1;
        continue;
      }
      lines.push({ text: rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine, consumedBytes });
    }

    if (Buffer.byteLength(this.buffered, 'utf8') > this.maxLineBytes) {
      discardedBytes += Buffer.byteLength(this.buffered, 'utf8');
      this.buffered = '';
      this.discardingOversizeLine = true;
      oversizeLines += 1;
    }

    return { lines, oversizeLines, discardedBytes };
  }

  get trailingPartialLine(): string {
    return this.buffered;
  }

  get isDiscardingOversizeLine(): boolean {
    return this.discardingOversizeLine;
  }
}
