import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { WorkspaceEngine, mergeWorkspaces } from '../src/shared/engine';
import { commandSchema, emptyWorkspace, parseWorkspace } from '../src/shared/model';
import { boardAssetIds, boardCardTitle, boardLayoutSchema, boardSize, boardSizes, MAX_BOARD_SIZE, clampBoardLayout, defaultBoard } from '../src/shared/board';
import { trashRecords } from '../src/shared/trash';
import { DataStore } from '../electron/storage';
import { PreferencesStore } from '../electron/preferences';
import { FolderStorage } from '../electron/folder-storage';
import { DocumentFiles } from '../electron/document-files';
import { temporaryDirectory } from './helpers';

async function device(t: TestContext) {
  const root = await temporaryDirectory(t); const store = new DataStore(root); await store.initialize();
  const preferences = new PreferencesStore(root); await preferences.initialize();
  const documents = new DocumentFiles(root, { settleMs: 0 });
  const folder = new FolderStorage(store, preferences, () => {}, documents); await folder.initialize();
  return { root, store, preferences, folder, documents };
}
const png = () => readFile(path.resolve('assets/icon.png'));

test('legacy workspaces gain an empty board without changing tasks; board inputs are bounded', () => {
  const engine = new WorkspaceEngine('old'); engine.apply({ type: 'task.add', title: '旧任务', listId: 'inbox' });
  const legacy = JSON.parse(JSON.stringify(engine.state)); delete legacy.boards; delete legacy.boardCards;
  const migrated = parseWorkspace(legacy);
  assert.deepEqual(migrated.tasks, engine.state.tasks); assert.deepEqual(migrated.boards, []); assert.deepEqual(migrated.boardCards, []);
  assert.equal(commandSchema.safeParse({ type: 'board.card.add', content: { kind: 'image', assetId: '../secret.png', name: 'x' } }).success, false);
  assert.equal(boardLayoutSchema.safeParse({ x: MAX_BOARD_SIZE - 100, y: 0, width: 300, height: 200 }).success, false);
  assert.equal(boardLayoutSchema.safeParse({ x: Infinity, y: 0, width: 300, height: 200 }).success, false);
  assert.deepEqual(clampBoardLayout({ x: 7000, y: -1, width: 2000, height: 20 }), { x: 4400, y: 0, width: 1600, height: 100 });
  assert.ok(boardLayoutSchema.safeParse(clampBoardLayout({ x: 5839.5, y: 5899.5, width: 160.5, height: 100.5 })).success, 'rounding must not push the card beyond the canvas edge');
});

test('board sizes accept presets and custom bounds, retain legacy space and clamp cards without losing content', () => {
  const engine = new WorkspaceEngine('sizes');
  assert.deepEqual(boardSize(engine.state), { width: 1600, height: 1000 });
  for (const preset of boardSizes) assert.ok(commandSchema.safeParse({ type: 'board.update', patch: { size: { width: preset.width, height: preset.height } } }).success);
  for (const size of [{ width: 479, height: 500 }, { width: 500, height: 319 }, { width: 12001, height: 500 }, { width: 500.5, height: 500 }]) assert.equal(commandSchema.safeParse({ type: 'board.update', patch: { size } }).success, false);
  engine.apply({ type: 'board.update', patch: { size: { width: 6000, height: 6000 } } });
  engine.apply({ type: 'board.card.add', content: { kind: 'text', text: '保留边缘内容' }, layout: { x: 5400, y: 5400, width: 600, height: 600 } });
  engine.apply({ type: 'board.update', patch: { size: { width: 900, height: 600 } } });
  assert.deepEqual(engine.state.boardCards[0].values.layout, { x: 300, y: 0, width: 600, height: 600 });
  assert.deepEqual(engine.state.boardCards[0].values.content, { kind: 'text', text: '保留边缘内容' });
  engine.apply({ type: 'board.update', patch: { backgroundColor: '#112233' } });
  assert.deepEqual(boardSize(parseWorkspace(JSON.parse(JSON.stringify(engine.state)))), { width: 900, height: 600 });
  const legacy = JSON.parse(JSON.stringify(engine.state)); delete legacy.boards[0].values.size; delete legacy.boards[0].clocks.size;
  assert.deepEqual(boardSize(parseWorkspace(legacy)), { width: 6000, height: 6000 });
});

test('first board settings on two devices merge independently; card layout and text retain both edits', () => {
  const a = new WorkspaceEngine('a'), b = new WorkspaceEngine('b');
  a.apply({ type: 'board.update', patch: { backgroundColor: '#112233' } });
  b.apply({ type: 'board.update', patch: { backgroundDim: 0.4 } });
  const merged = mergeWorkspaces(a.state, b.state);
  assert.deepEqual(merged.boards[0].values, { ...defaultBoard, backgroundColor: '#112233', backgroundDim: 0.4 });
  assert.deepEqual(merged, mergeWorkspaces(b.state, a.state));
  a.apply({ type: 'board.card.add', content: { kind: 'text', text: '最初的标语' } });
  b.merge(a.state); const id = a.state.boardCards[0].id;
  a.apply({ type: 'board.card.update', id, patch: { layout: { x: 100, y: 200, width: 400, height: 300 } } });
  b.apply({ type: 'board.card.update', id, patch: { content: { kind: 'text', text: '更新的标语' }, color: '#abcdef' } });
  const next = mergeWorkspaces(a.state, b.state);
  assert.deepEqual(next, mergeWorkspaces(b.state, a.state));
  assert.deepEqual(next.boardCards[0].values.layout, { x: 100, y: 200, width: 400, height: 300 });
  assert.deepEqual(next.boardCards[0].values.content, { kind: 'text', text: '更新的标语' });
  assert.equal(next.boardCards[0].values.color, '#abcdef');
});

test('source pins stay live, removal and purge never delete originals, stale merges cannot restore purged pins', () => {
  const engine = new WorkspaceEngine('pin-test');
  engine.apply({ type: 'board.source.add', kind: 'task', title: '原任务', content: '' });
  engine.apply({ type: 'board.source.add', kind: 'note', title: '原便签', content: '内容' });
  const task = engine.state.tasks[0], note = engine.state.notes[0];
  const card = engine.state.boardCards[0];
  engine.apply({ type: 'task.update', id: task.id, patch: { title: '更新的任务', completed: true } });
  assert.equal(boardCardTitle(card, engine.state), '更新的任务');
  assert.throws(() => engine.apply({ type: 'board.card.update', id: card.id, patch: { content: { kind: 'text', text: '替换来源' } } }));
  const stale = structuredClone(engine.state);
  engine.apply({ type: 'board.card.update', id: card.id, patch: { deleted: true } });
  const target = trashRecords(engine.state)[0]; assert.equal(target.kind, 'boardCard');
  engine.restore(target); assert.equal(card.values.deleted, false);
  engine.apply({ type: 'board.card.update', id: card.id, patch: { deleted: true } });
  engine.purge(trashRecords(engine.state)); engine.merge(stale);
  assert.equal(engine.state.boardCards.some(item => item.id === card.id), false);
  assert.equal(engine.state.tasks[0].values.deleted, false); assert.equal(engine.state.notes[0].values.deleted, false);
  engine.apply({ type: 'note.update', id: note.id, patch: { deleted: true } });
  assert.equal(boardCardTitle(engine.state.boardCards[0], engine.state), '便签已删除');
  engine.purge(trashRecords(engine.state));
  assert.equal(boardCardTitle(engine.state.boardCards[0], engine.state), '便签已删除');
  assert.throws(() => engine.apply({ type: 'board.card.add', content: { kind: 'note', sourceId: note.id } }));
});

test('layer commands are atomic and preserve the order of other cards', () => {
  const engine = new WorkspaceEngine('layer');
  for (const text of ['一', '二', '三']) engine.apply({ type: 'board.card.add', content: { kind: 'text', text } });
  const [a, b, c] = engine.state.boardCards;
  engine.apply({ type: 'board.card.layer', id: a.id, front: true });
  const order = () => [...engine.state.boardCards].sort((x, y) => x.values.z - y.values.z).map(x => x.id);
  assert.deepEqual(order(), [b.id, c.id, a.id]);
  engine.apply({ type: 'board.card.layer', id: a.id, front: false }); assert.deepEqual(order(), [a.id, b.id, c.id]);
});

test('board images and background survive folder sync, relocation, restart and JSON backup restore', async t => {
  const first = await device(t), second = await device(t); const image = await png();
  await first.folder.addBoardImage({ destination: 'card' }, image, '示例图片.png');
  await first.folder.addBoardImage({ destination: 'background' }, image, '背景.png');
  const id = boardAssetIds(first.store.engine.state)[0];
  assert.deepEqual(await readFile(path.join(first.folder.directory, 'assets', id)), image);
  await second.folder.changeDirectory(first.folder.directory);
  assert.equal(second.store.engine.state.boardCards.length, 1);
  assert.equal(second.store.engine.state.boards[0].values.backgroundId, id);
  assert.deepEqual((await second.documents.readBoardImage(second.folder.directory, second.store.engine.state, id)).bytes, image);
  const nextFolder = path.join(first.root, 'moved-board'); await mkdir(nextFolder); await first.folder.changeDirectory(nextFolder);
  assert.deepEqual(await readFile(path.join(nextFolder, 'assets', id)), image);
  const restarted = new DataStore(first.root); await restarted.initialize();
  assert.deepEqual(restarted.engine.state.boardCards, first.store.engine.state.boardCards);
  const backup = JSON.parse(await first.documents.backup(first.store.engine.state));
  assert.equal(Object.keys(backup.attachments).length, 1, 'same image deduplicates across background and card');
  const restored = await device(t); await restored.folder.importBackup(parseWorkspace(backup), backup.attachments);
  assert.deepEqual((await restored.documents.readBoardImage(restored.folder.directory, restored.store.engine.state, id)).bytes, image);
  assert.deepEqual(restored.store.engine.state.boards, first.store.engine.state.boards);
});

test('image cleanup protects active backgrounds and recoverable pins, then removes unreferenced files after purge', async t => {
  const f = await device(t); const image = await png();
  await f.folder.addBoardImage({ destination: 'card' }, image, '保留.png');
  await f.folder.addBoardImage({ destination: 'background' }, image, '背景.png');
  const card = f.store.engine.state.boardCards[0], id = boardAssetIds(f.store.engine.state)[0];
  await f.folder.update(engine => engine.apply({ type: 'board.card.update', id: card.id, patch: { deleted: true } }));
  await f.folder.purgeTrash([]); assert.ok(await stat(path.join(f.root, 'media', id)));
  assert.ok(JSON.parse(await f.documents.backup(f.store.engine.state)).attachments[id]);
  await f.folder.purgeTrash(trashRecords(f.store.engine.state));
  assert.ok(await stat(path.join(f.root, 'media', id)), 'background protects a purged card image');
  await f.folder.update(engine => engine.apply({ type: 'board.update', patch: { backgroundId: null } }));
  await f.folder.purgeTrash([]); assert.ok(await stat(path.join(f.root, 'media', id)), 'one-generation local backup protects replaced background');
  await f.folder.update(engine => engine.apply({ type: 'board.update', patch: { backgroundColor: '#abcdef' } }));
  await f.folder.purgeTrash([]);
  await assert.rejects(stat(path.join(f.root, 'media', id)));
  await assert.rejects(stat(path.join(f.folder.directory, 'assets', id)));
});

test('background preview is staged without saving and image reads reject traversal, unknown IDs and changed bytes', async t => {
  const f = await device(t); const image = await png();
  const id = await f.documents.stageBoardImage(image);
  assert.deepEqual(f.store.engine.state, emptyWorkspace());
  assert.deepEqual((await f.documents.readBoardImage(f.folder.directory, f.store.engine.state, id)).bytes, image);
  await assert.rejects(f.documents.readBoardImage(f.folder.directory, f.store.engine.state, '../workspace.json'));
  await assert.rejects(f.documents.readBoardImage(f.folder.directory, f.store.engine.state, `${'a'.repeat(64)}.png`));
  await writeFile(path.join(f.root, 'media', id), Buffer.from('changed bytes'));
  await assert.rejects(f.documents.readBoardImage(f.folder.directory, f.store.engine.state, id));
});

test('board asset directory junctions cannot redirect writes or cleanup outside the data folder', async t => {
  const f = await device(t); const outside = path.join(f.root, 'outside'); await mkdir(outside);
  await writeFile(path.join(outside, 'keep.txt'), '不要修改');
  try { await symlink(outside, path.join(f.folder.directory, 'assets'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('symlink unavailable'); return; } throw error; }
  await f.folder.addBoardImage({ destination: 'card' }, await png(), '图片.png');
  assert.match(f.folder.status.error!, /符号链接/);
  await assert.rejects(f.folder.purgeTrash([]));
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), '不要修改');
});
