// Captures one output stream of a command.
//
// The agent sees the start and the end of each stretch of output (errors are
// usually at the end); everything in between is omitted from the reply but kept
// in a file on the host, so nothing is lost. Output is read in segments: each
// take() returns what arrived since the previous one, which is how a running
// job reports only new output.

import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export const HEAD_BYTES = 20_000;
export const TAIL_BYTES = 20_000;

export class Output {
  constructor(spoolPath) {
    this.spoolPath = spoolPath;
    this.total = 0;
    this.pending = []; // everything so far, until it's big enough to need a file
    this.file = null;
    this.fileFailed = false;
    this.newSegment();
  }

  newSegment() {
    this.seg = { bytes: 0, head: [], headBytes: 0, tail: [], tailBytes: 0 };
  }

  write(chunk) {
    this.total += chunk.length;
    if (this.file) this.file.write(chunk);
    else if (!this.fileFailed) {
      this.pending.push(chunk);
      if (this.total > HEAD_BYTES + TAIL_BYTES) this.openFile();
    }

    const seg = this.seg;
    seg.bytes += chunk.length;
    if (seg.headBytes < HEAD_BYTES) {
      const part = chunk.subarray(0, HEAD_BYTES - seg.headBytes);
      seg.head.push(part);
      seg.headBytes += part.length;
    }
    seg.tail.push(chunk);
    seg.tailBytes += chunk.length;
    while (seg.tail.length > 1 && seg.tailBytes - seg.tail[0].length >= TAIL_BYTES) {
      seg.tailBytes -= seg.tail.shift().length;
    }
  }

  openFile() {
    try {
      mkdirSync(dirname(this.spoolPath), { recursive: true, mode: 0o700 });
      this.file = createWriteStream(this.spoolPath, { mode: 0o600 });
      this.file.on("error", () => { this.fileFailed = true; });
      for (const c of this.pending) this.file.write(c);
    } catch {
      this.fileFailed = true;
    }
    this.pending = null;
  }

  // Output since the last take(), shortened to its start and end if it's long.
  take() {
    const seg = this.seg;
    this.newSegment();
    const head = Buffer.concat(seg.head);
    if (seg.bytes <= HEAD_BYTES + TAIL_BYTES) {
      const rest = seg.bytes - head.length;
      return head.toString("utf8") + (rest > 0 ? Buffer.concat(seg.tail).subarray(-rest).toString("utf8") : "");
    }
    const omitted = seg.bytes - HEAD_BYTES - TAIL_BYTES;
    const where = this.file && !this.fileFailed ? `full output: ${this.spoolPath}` : "the full output couldn't be saved";
    return `${head.toString("utf8")}\n[… ${omitted} bytes omitted; ${where} …]\n${Buffer.concat(seg.tail).subarray(-TAIL_BYTES).toString("utf8")}`;
  }

  close() {
    this.file?.end();
  }
}

// Output files are for the session at hand; clear out old ones at startup.
export function pruneOutputFiles(dir, maxAgeMs = 24 * 60 * 60 * 1000) {
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    const p = join(dir, name);
    try { if (Date.now() - statSync(p).mtimeMs > maxAgeMs) unlinkSync(p); } catch {}
  }
}
