import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { EditorView, type DecorationSet } from '@codemirror/view';
import { liveMarkdown, markdownImageURL, refreshMarkdown } from '../src/components/live-markdown';

const context = { target: { kind: 'note' as const, id: 'test-note' }, assets: {}, disabled: false, openLink() {}, onError(message: string) { throw new Error(message); } };
function ranges(state: EditorState) {
  const result: { from: number; to: number; spec: Record<string, any> }[] = [];
  for (const set of state.facet(EditorView.decorations)) if (typeof set !== 'function') {
    (set as DecorationSet).between(0, state.doc.length, (from, to, decoration) => { result.push({ from, to, spec: decoration.spec }); });
  }
  return result;
}
test('live formatting preserves Markdown exactly, reveals the table at the cursor, and resumes rendering on blur', () => {
  const content = '# 中文标题\n\n**强调**和 `**字面代码**`\n\n| A | B |\n| - | - |\n| 1 | 2 |\n';
  let state = EditorState.create({ doc: content, extensions: liveMarkdown(() => context) });
  assert.equal(state.doc.toString(), content);
  assert.equal(ranges(state).filter(range => range.spec.class === 'cm-md-strong').length, 1, 'code must not be formatted as emphasis');
  const table = ranges(state).find(range => range.spec.block); assert.ok(table);
  const focus = state.facet(EditorView.focusChangeEffect)[0];
  state = state.update({ selection: { anchor: content.indexOf('| 1') + 2 }, effects: focus(state, true)! }).state;
  assert.equal(ranges(state).some(range => range.spec.block), false);
  state = state.update({ effects: focus(state, false)! }).state;
  assert.equal(ranges(state).some(range => range.spec.block), true);
  assert.equal(state.doc.toString(), content);
});
test('rendering handles long documents, nested blocks, reference links and incomplete syntax without rewriting input', () => {
  for (const value of ['> '.repeat(250) + '深层引用', '- **未完成\n\n```js\nconst a =', '![图][图片]\n\n[图片]: assets/中文.png', ('段落 **内容**\n\n').repeat(5000)]) {
    const state = EditorState.create({ doc: value, extensions: liveMarkdown(() => context) });
    for (const range of ranges(state)) assert.ok(range.from >= 0 && range.to <= value.length && range.to >= range.from);
    assert.equal(state.doc.toString(), value);
  }
});
test('live images use document-scoped URLs and never load scripts, arbitrary local files or data URLs', () => {
  assert.match(markdownImageURL('assets/中文%20图.png', context), /^gtodo:\/\/app\/media\/note\/test-note\//);
  for (const url of ['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'file:///C:/secret.png', '../private.png', 'assets/../secret.png', 'http://example.test/a.png']) assert.equal(markdownImageURL(url, context), '');
  assert.equal(markdownImageURL('https://example.test/a.png', context), 'https://example.test/a.png');
});

test('tables refresh when referenced links or the document image scope change', () => {
  const content = '| [链接][a] |\n| --- |\n| 内容 |\n\n[a]: https://example.test/first';
  let current = context;
  let state = EditorState.create({ doc: content, extensions: liveMarkdown(() => current) });
  const widget = (value: EditorState) => ranges(value).find(range => range.spec.block)!.spec.widget;
  const first = widget(state);
  state = state.update({ changes: { from: content.indexOf('/first'), to: content.length, insert: '/second' } }).state;
  const second = widget(state);
  assert.equal(first.eq(second), false, 'a changed definition must update the rendered link');
  current = { ...context, target: { kind: 'note', id: 'another-note' } };
  state = state.update({ effects: refreshMarkdown.of() }).state;
  assert.equal(second.eq(widget(state)), false, 'scoped images must not retain the previous document');
});
