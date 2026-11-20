import test from 'node:test';
import assert from 'node:assert/strict';
import { withSavedWorkspace } from '../electron/workspace-actions';
import { FieldDraft } from '../src/notes/draft';

test('workspace actions include unsaved changes from both editors before taking a snapshot', async () => {
  let savedMain = '原任务', savedNote = '原便签'; let resumed = false;
  const main = new FieldDraft({ title: savedMain }, async patch => { savedMain = patch.title!; return { title: savedMain }; }, 60000);
  const note = new FieldDraft({ content: savedNote }, async patch => { savedNote = patch.content!; return { content: savedNote }; }, 60000);
  main.change('title', '最后输入的任务名称'); note.change('content', '最后输入的便签内容');
  try {
    const backup = await withSavedWorkspace(async () => ({ title: savedMain, content: savedNote }), {
      flushMain: async () => { await main.flush(); return true; }, flushNotes: async () => { await note.flush(); return true; },
      resume: () => { resumed = true; }, failureMessage: '内容尚未保存',
    });
    assert.deepEqual(backup, { title: '最后输入的任务名称', content: '最后输入的便签内容' }); assert.equal(resumed, true);
  } finally { main.dispose(); note.dispose(); }
});

test('workspace actions abort without replacing files when either editor fails, then can retry', async () => {
  for (const failed of ['main', 'notes']) {
    let written = false, resumed = 0, fail = true;
    const options = {
      flushMain: async () => !(fail && failed === 'main'), flushNotes: async () => !(fail && failed === 'notes'),
      resume: () => { resumed++; }, failureMessage: '内容尚未保存',
    };
    await assert.rejects(withSavedWorkspace(async () => { written = true; }, options), /尚未保存/);
    assert.equal(written, false); assert.equal(resumed, 1);
    fail = false; await withSavedWorkspace(async () => { written = true; }, options);
    assert.equal(written, true); assert.equal(resumed, 2);
  }
});

test('a throwing flush does not re-enable windows while the other editor is still saving', async () => {
  let release!: () => void, started!: () => void; let resumed = false, acted = false;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const action = withSavedWorkspace(async () => { acted = true; }, {
    flushMain: async () => { throw new Error('主窗口保存失败'); },
    flushNotes: async () => { started(); await pending; return true; },
    resume: () => { resumed = true; }, failureMessage: '内容尚未保存',
  });
  const rejected = assert.rejects(action, /尚未保存/);
  await waiting; assert.equal(resumed, false); release(); await rejected;
  assert.equal(acted, false); assert.equal(resumed, true);
});

test('file I/O failures always re-enable the editor windows', async () => {
  let resumed = false;
  await assert.rejects(withSavedWorkspace(async () => { throw new Error('备份路径不可写'); }, {
    flushMain: async () => true, flushNotes: async () => true, resume: () => { resumed = true; }, failureMessage: '内容尚未保存',
  }), /路径不可写/);
  assert.equal(resumed, true);
});
