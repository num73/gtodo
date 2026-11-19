import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

// Local, bounded error history. Callers record technical failures, never note text.
export class Diagnostics {
  private queue: Promise<unknown> = Promise.resolve();
  readonly file: string;
  constructor(directory: string, private maxBytes = 512 * 1024) { this.file = path.join(directory, 'diagnostics.log'); }
  report = (event: string, details: Record<string, unknown>) => {
    const entry = JSON.stringify({ time: new Date().toISOString(), event, ...details }) + '\n';
    console.error(event, details);
    this.queue = this.queue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const size = await stat(this.file).then(value => value.size, error => {
        if (error.code === 'ENOENT') return 0; throw error;
      });
      if (size && size + Buffer.byteLength(entry) > this.maxBytes) await rename(this.file, `${this.file}.previous`);
      await appendFile(this.file, entry, 'utf8');
    }).catch(error => console.error('Unable to write diagnostics:', error));
  };
  async flush() { await this.queue; }
}
