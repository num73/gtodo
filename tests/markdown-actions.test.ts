import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownEdit } from '../src/components/markdown-actions';

const apply = (value: string, edit: ReturnType<typeof markdownEdit>) => value.slice(0, edit.from) + edit.text + value.slice(edit.to);
test('formatting preserves surrounding Markdown, selections and independent line boundaries', () => {
  const initial = '首行\n正文\n尾行';
  const heading = markdownEdit(initial, 0, 3, 'h2');
  assert.equal(apply(initial, heading), '## 首行\n正文\n尾行');
  assert.equal(apply('## 首行\n正文', markdownEdit('## 首行\n正文', 2, 2, 'h2')), '首行\n正文');
  assert.equal(apply(initial, markdownEdit(initial, 3, 6, 'check')), '首行\n- [ ] 正文\n尾行');
  assert.equal(apply('a\nb\nc', markdownEdit('a\nb\nc', 0, 4, 'ordered')), '1. a\n2. b\nc');
  const bold = markdownEdit('前文字后', 1, 3, 'bold');
  assert.equal(apply('前文字后', bold), '前**文字**后');
  const unbold = markdownEdit('前**文字**后', bold.selectFrom, bold.selectTo, 'bold');
  assert.equal(apply('前**文字**后', unbold), '前文字后');
  assert.equal(apply('', markdownEdit('', 0, 0, 'h1')), '# ');
});
