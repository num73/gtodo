import type { Clock, DocumentRevision, Workspace } from './model';
import type { AssetMap, DocumentTarget } from './documents';
import { compareClock } from './note-links';

type Body = DocumentTarget & { content: string; assets: AssetMap; clock: Clock; contentClock: Clock; assetsClock: Clock };
export function documentBodies(workspace: Workspace): Map<string, Body> {
  return new Map([
    ...workspace.tasks.map(task => ({ kind: 'task' as const, id: task.id, content: task.values.notes, assets: task.values.notesAssets, contentClock: task.clocks.notes, assetsClock: task.clocks.notesAssets, clock: compareClock(task.clocks.notes, task.clocks.notesAssets) >= 0 ? task.clocks.notes : task.clocks.notesAssets })),
    ...workspace.notes.map(note => ({ kind: 'note' as const, id: note.id, content: note.values.content, assets: note.values.assets, contentClock: note.clocks.content, assetsClock: note.clocks.assets, clock: compareClock(note.clocks.content, note.clocks.assets) >= 0 ? note.clocks.content : note.clocks.assets })),
  ].map(body => [`${body.kind}:${body.id}`, body]));
}
export function revisionId(body: Body) { return `${body.kind}:${body.id}:${body.contentClock.tick}@${body.contentClock.device}:${body.assetsClock.tick}@${body.assetsClock.device}`; }
export function mergeRevisions(...sources: DocumentRevision[][]): DocumentRevision[] {
  const result = new Map<string, DocumentRevision>();
  for (const revision of sources.flat()) {
    const prior = result.get(revision.id);
    if (prior && (prior.content !== revision.content || prior.kind !== revision.kind || prior.targetId !== revision.targetId || JSON.stringify(Object.entries(prior.assets).sort()) !== JSON.stringify(Object.entries(revision.assets).sort()))) throw new Error('正文历史版本冲突，请保留数据文件并检查备份。');
    result.set(revision.id, { ...revision, parents: [...new Set([...(prior?.parents ?? []), ...revision.parents])].sort() });
  }
  return [...result.values()].sort((a, b) => compareClock(a.clock, b.clock) || a.id.localeCompare(b.id, 'en'));
}
export function captureDocumentHistory(workspace: Workspace, before = documentBodies(workspace), otherParents: Map<string, Body>[] = []) {
  const revisions = [...(workspace.documentRevisions ?? [])];
  const known = new Set(revisions.map(revision => revision.id));
  for (const [key, body] of documentBodies(workspace)) {
    if (!body.content && !Object.keys(body.assets).length && !before.get(key)?.content && !Object.keys(before.get(key)?.assets ?? {}).length) continue;
    const id = revisionId(body); if (known.has(id)) continue;
    const parents = [...new Set([before, ...otherParents].flatMap(source => { const previous = source.get(key); return previous && revisionId(previous) !== id ? [revisionId(previous)] : []; }))];
    revisions.push({ id, kind: body.kind, targetId: body.id, clock: { ...body.clock }, parents, content: body.content, assets: { ...body.assets } }); known.add(id);
  }
  const purged = new Set(workspace.purged.map(marker => `${marker.kind}:${marker.id}`));
  const groups = new Map<string, DocumentRevision[]>();
  for (const revision of mergeRevisions(revisions)) {
    const key = `${revision.kind}:${revision.targetId}`; if (purged.has(key)) continue;
    const values = groups.get(key) ?? []; values.push(revision); groups.set(key, values);
  }
  // Keep recent ancestry plus every unresolved branch head, including old forks.
  workspace.documentRevisions = [...groups.values()].flatMap(values => {
    const parents = new Set(values.flatMap(value => value.parents)), recent = new Set(values.slice(-50).map(value => value.id));
    return values.filter(value => recent.has(value.id) || !parents.has(value.id));
  }).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  return workspace;
}
export function documentHistory(workspace: Workspace, target: DocumentTarget) {
  const versions = workspace.documentRevisions.filter(item => item.kind === target.kind && item.targetId === target.id).sort((a, b) => compareClock(b.clock, a.clock));
  const parents = new Set(versions.flatMap(version => version.parents));
  return { versions, heads: versions.filter(version => !parents.has(version.id)).map(version => version.id) };
}
