import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Read-only assertion helper for isolated native-test profiles.
export async function readTestWorkspace(root) {
  const relative = path.relative(path.resolve('.qa'), path.resolve(root));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Only isolated test profiles are allowed');
  const saved = JSON.parse(await readFile(path.join(root, 'workspace.json'), 'utf8'));
  if (saved.workspace.format !== 'gtodo-records') return saved.workspace;
  const result = { schemaVersion: saved.workspace.schemaVersion };
  for (const [collection, hashes] of Object.entries(saved.workspace.records)) {
    result[collection] = [];
    for (const hash of hashes) {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid block hash');
      const bytes = await readFile(path.join(root, 'records', hash.slice(0, 2), `${hash}.json`));
      if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('Invalid block bytes');
      result[collection].push(JSON.parse(bytes.toString()));
    }
  }
  return result;
}
