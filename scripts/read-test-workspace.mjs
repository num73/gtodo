import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Read-only assertion helper for isolated native-test profiles.
export async function readTestWorkspace(root) {
  const relative = path.relative(path.resolve('.qa'), path.resolve(root));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Only isolated test profiles are allowed');
  let file = path.join(root, 'workspace.json'), recordsRoot = root;
  try {
    const preferences = JSON.parse(await readFile(path.join(root, 'preferences.json'), 'utf8'));
    if (preferences.storageVersion === 3) {
      recordsRoot = preferences.dataPath;
      const relative = path.relative(path.resolve('.qa'), path.resolve(recordsRoot));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Only isolated test data is allowed');
      file = path.join(recordsRoot, '.gtodo', 'devices', preferences.deviceId, 'workspace.json');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const saved = JSON.parse(await readFile(file, 'utf8'));
  if (saved.workspace.format !== 'gtodo-records') return saved.workspace;
  const result = { schemaVersion: saved.workspace.schemaVersion };
  for (const [collection, hashes] of Object.entries(saved.workspace.records)) {
    result[collection] = [];
    for (const hash of hashes) {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid block hash');
      const bytes = await readFile(path.join(recordsRoot, 'records', hash.slice(0, 2), `${hash}.json`));
      if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('Invalid block bytes');
      result[collection].push(JSON.parse(bytes.toString()));
    }
  }
  return result;
}
