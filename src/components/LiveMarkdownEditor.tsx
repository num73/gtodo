import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap, placeholder, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { liveMarkdown, refreshMarkdown, type MarkdownContext } from './live-markdown';

export interface LiveEditorHandle {
  focus(): void;
  getSelection(): { start: number; end: number };
  setSelection(start: number, end: number): void;
  replaceRange(from: number, to: number, text: string): void;
  openSearch(): void;
}
type Props = MarkdownContext & { value: string; label: string; initialSelection: { start: number; end: number }; onChange: (value: string) => void; onSelection: (selection: { start: number; end: number }) => void; onBlur: () => void; onSave: () => void; onFiles: (files: File[]) => void; onError: (error: string) => void };
const external = Annotation.define<boolean>();
function toggleMark(view: EditorView, marker: string) {
  if (view.state.readOnly) return false;
  const { from, to } = view.state.selection.main, source = view.state.doc.toString();
  if (source.slice(Math.max(0, from - marker.length), from) === marker && source.slice(to, to + marker.length) === marker) {
    view.dispatch({ changes: [{ from: from - marker.length, to: from, insert: '' }, { from: to, to: to + marker.length, insert: '' }], selection: { anchor: from - marker.length, head: to - marker.length }, userEvent: 'input', annotations: isolateHistory.of('full') });
  } else view.dispatch({ changes: { from, to, insert: marker + source.slice(from, to) + marker }, selection: { anchor: from + marker.length, head: to + marker.length }, userEvent: 'input', annotations: isolateHistory.of('full') });
  return true;
}
const highlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: '#a626a4' },
  { tag: [tags.string, tags.regexp], color: '#37783f' },
  { tag: [tags.number, tags.bool, tags.null], color: '#986801' },
  { tag: [tags.function(tags.variableName), tags.typeName], color: '#225ca1' },
  { tag: tags.comment, color: '#777' },
]);
export default forwardRef<LiveEditorHandle, Props>(function LiveMarkdownEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null);
  const latest = useRef(props); latest.current = props;
  const readOnly = useRef(new Compartment());
  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    getSelection: () => ({ start: view.current?.state.selection.main.from ?? 0, end: view.current?.state.selection.main.to ?? 0 }),
    setSelection: (start, end) => { const editor = view.current; if (editor) editor.dispatch({ selection: { anchor: Math.min(start, editor.state.doc.length), head: Math.min(end, editor.state.doc.length) }, scrollIntoView: true }); },
    replaceRange: (from, to, text) => { view.current?.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input', annotations: isolateHistory.of('full') }); },
    openSearch: () => { if (view.current) openSearchPanel(view.current); },
  }), []);
  useLayoutEffect(() => {
    const initial = latest.current;
    const editor = new EditorView({ parent: host.current!, state: EditorState.create({ doc: initial.value,
      selection: { anchor: Math.min(initial.initialSelection.start, initial.value.length), head: Math.min(initial.initialSelection.end, initial.value.length) },
      extensions: [
        history(), drawSelection(), EditorView.lineWrapping,
        search({ top: true }),
        EditorState.phrases.of({ 'Find': '查找', 'Replace': '替换为', 'next': '下一处', 'previous': '上一处', 'all': '全选匹配', 'match case': '区分大小写', 'regexp': '正则表达式', 'by word': '完整单词', 'replace': '替换', 'replace all': '全部替换', 'close': '关闭', 'Go to line': '跳转到行' }),
        markdown({ base: markdownLanguage, codeLanguages: languages, completeHTMLTags: false, pasteURLAsLink: false }),
        keymap.of([{ key: 'Mod-s', run: () => { latest.current.onSave(); return true; } }, { key: 'Mod-b', run: view => toggleMark(view, '**') }, { key: 'Mod-i', run: view => toggleMark(view, '*') }, { key: 'Mod-h', run: openSearchPanel }, ...searchKeymap, ...defaultKeymap, ...historyKeymap]),
        syntaxHighlighting(highlighting), liveMarkdown(() => latest.current),
        placeholder(initial.label === '备注' ? '添加备注，支持 Markdown' : '输入内容，支持 Markdown'),
        EditorView.contentAttributes.of({ 'aria-label': initial.label, 'aria-multiline': 'true', spellcheck: 'false' }),
        readOnly.current.of([EditorState.readOnly.of(initial.disabled), EditorView.editable.of(!initial.disabled)]),
        EditorState.changeFilter.of(transaction => {
          if (transaction.newDoc.length <= 100000) return true;
          queueMicrotask(() => latest.current.onError('内容不能超过 100000 个字符。')); return false;
        }),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !update.transactions.every(transaction => transaction.annotation(external))) latest.current.onChange(update.state.doc.toString());
          if (update.selectionSet || update.docChanged) latest.current.onSelection({ start: update.state.selection.main.from, end: update.state.selection.main.to });
        }),
        EditorView.domEventHandlers({
          blur: () => { latest.current.onBlur(); },
          paste: event => {
            const files = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith('image/'));
            if (!files.length || latest.current.disabled) return false;
            event.preventDefault(); latest.current.onFiles(files); return true;
          },
          dragover: event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); return true; } return false; },
          drop: (event, editor) => {
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (!files.length || latest.current.disabled) return false;
            event.preventDefault(); const position = editor.posAtCoords({ x: event.clientX, y: event.clientY });
            if (position !== null) editor.dispatch({ selection: { anchor: position } });
            latest.current.onFiles(files); return true;
          },
        }),
      ],
    }) });
    view.current = editor;
    return () => { view.current = null; editor.destroy(); };
  }, []);
  useLayoutEffect(() => {
    const editor = view.current; if (!editor) return;
    const before = editor.state.doc.toString(); if (before === props.value) return;
    let from = 0, tail = 0;
    while (from < Math.min(before.length, props.value.length) && before[from] === props.value[from]) from++;
    while (tail < Math.min(before.length, props.value.length) - from && before[before.length - 1 - tail] === props.value[props.value.length - 1 - tail]) tail++;
    editor.dispatch({ changes: { from, to: before.length - tail, insert: props.value.slice(from, props.value.length - tail) }, annotations: [external.of(true), Transaction.addToHistory.of(false)] });
  }, [props.value]);
  useLayoutEffect(() => { view.current?.dispatch({ effects: [readOnly.current.reconfigure([EditorState.readOnly.of(props.disabled), EditorView.editable.of(!props.disabled)]), refreshMarkdown.of()] }); }, [props.disabled, props.assets, props.target.kind, props.target.id]);
  return <div ref={host} className="document-live" data-editor="live-markdown" />;
});
