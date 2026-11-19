import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { TestContext } from 'node:test';

export async function temporaryDirectory(t: TestContext) {
  const root = path.resolve('.qa', 'tests'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'case-'));
  t.after(async () => {
    const relative = path.relative(root, path.resolve(directory));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup path');
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
