// The last lines a process wrote to stderr, kept for the error shown when it ends (a Claude chat's,
// a Codex connection's). Chunks do not end at line ends: a line split across two is joined first.

/** How long an unfinished line may grow before its start is dropped. */
const MAX_PARTIAL = 8192;

export class StderrTail {
  private lines: string[] = [];
  private partial = '';

  constructor(private readonly max = 40) {}

  /** Takes a chunk; returns the whole lines it finished, blank ones left out. */
  push(chunk: string): string[] {
    const parts = (this.partial + chunk).split('\n');
    this.partial = (parts.pop() ?? '').slice(-MAX_PARTIAL);
    const finished = parts.filter((line) => line.trim().length > 0);
    this.lines.push(...finished);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
    return finished;
  }

  /** The lines kept, an unfinished last one included. */
  text(): string {
    const lines = this.partial.trim() ? [...this.lines, this.partial] : this.lines;
    return lines.slice(-this.max).join('\n');
  }
}
