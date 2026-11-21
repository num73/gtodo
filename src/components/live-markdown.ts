import { StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { assetURL, normalizeAssetPath, type AssetMap, type DocumentTarget } from '../shared/documents';

type Node = { type: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: Node[]; value?: string; url?: string; alt?: string; identifier?: string; depth?: number; checked?: boolean | null; ordered?: boolean; align?: (string | null)[] };
export type MarkdownContext = { target: DocumentTarget; assets: AssetMap; disabled: boolean; openLink: (url: string) => void; onError?: (message: string) => void };
export const refreshMarkdown = StateEffect.define<void>();
const focusMarkdown = StateEffect.define<boolean>();
const start = (node: Node) => node.position?.start.offset ?? 0;
const end = (node: Node) => node.position?.end.offset ?? start(node);
export const parseMarkdown = (value: string) => fromMarkdown(value, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as Node;
export function markdownImageURL(url: string, context: Pick<MarkdownContext, 'target' | 'assets'>) {
  const relative = normalizeAssetPath(url);
  return relative ? assetURL(context.target, relative, context.assets[relative]) : /^https:\/\//i.test(url) ? url : '';
}
function activate(view: EditorView, position: number) {
  view.dispatch({ selection: { anchor: Math.min(position, view.state.doc.length) }, effects: focusMarkdown.of(true), scrollIntoView: true });
  view.focus();
}
class ImageWidget extends WidgetType {
  constructor(readonly from: number, readonly src: string, readonly alt: string) { super(); }
  eq(other: ImageWidget) { return this.from === other.from && this.src === other.src && this.alt === other.alt; }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span'); wrap.className = 'cm-md-image'; wrap.tabIndex = 0;
    wrap.setAttribute('role', 'button'); wrap.setAttribute('aria-label', `编辑图片：${this.alt || '图片'}`); wrap.title = '点击编辑图片链接';
    const missing = () => { wrap.textContent = `${this.alt || '图片'} · 图片暂不可用`; wrap.classList.add('document-image-missing'); view.requestMeasure(); };
    if (this.src) {
      const img = document.createElement('img'); img.src = this.src; img.alt = this.alt; img.loading = 'lazy';
      img.onload = () => view.requestMeasure(); img.onerror = missing; wrap.append(img);
    } else missing();
    wrap.onmousedown = event => { event.preventDefault(); activate(view, this.from + 2); };
    wrap.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); activate(view, this.from + 2); } };
    return wrap;
  }
  ignoreEvent() { return true; }
}
class BulletWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: BulletWidget) { return this.text === other.text; }
  toDOM() { const span = document.createElement('span'); span.className = 'cm-md-bullet'; span.textContent = this.text; return span; }
  ignoreEvent() { return false; }
}
class CheckWidget extends WidgetType {
  constructor(readonly position: number, readonly checked: boolean, readonly disabled: boolean) { super(); }
  eq(other: CheckWidget) { return this.position === other.position && this.checked === other.checked && this.disabled === other.disabled; }
  toDOM(view: EditorView) {
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = this.checked; input.disabled = this.disabled;
    input.className = 'cm-md-checkbox'; input.setAttribute('aria-label', this.checked ? '标记为未完成' : '标记为完成');
    input.onmousedown = event => event.preventDefault();
    input.onchange = () => {
      if (view.state.readOnly) return;
      view.dispatch({ changes: { from: this.position, to: this.position + 1, insert: input.checked ? 'x' : ' ' }, userEvent: 'input' });
    };
    return input;
  }
  ignoreEvent() { return true; }
}
function inline(node: Node, parent: HTMLElement, context: MarkdownContext, definitions: Map<string, Node>, depth = 0) {
  if (depth > 200) {
    const pending = [node];
    while (pending.length) { const item = pending.pop()!; if (item.children) pending.push(...[...item.children].reverse()); else parent.append(document.createTextNode(item.value ?? '')); }
    return;
  }
  const resolved = node.identifier ? definitions.get(node.identifier) : node;
  const tag = ({ strong: 'strong', emphasis: 'em', delete: 's', inlineCode: 'code', link: 'a', linkReference: 'a' } as Record<string, string>)[node.type];
  if (node.type === 'html') { parent.append(document.createTextNode(node.value ?? '')); return; }
  if (node.type === 'image' || node.type === 'imageReference') {
    const src = markdownImageURL(resolved?.url ?? '', context);
    if (src) { const img = document.createElement('img'); img.src = src; img.alt = node.alt ?? ''; parent.append(img); }
    else parent.append(document.createTextNode(node.alt ?? '图片'));
    return;
  }
  const element = tag ? document.createElement(tag) : parent;
  if (tag === 'a' && /^https?:\/\//i.test(resolved?.url ?? '')) {
    const link = element as HTMLAnchorElement; link.href = resolved!.url!; link.title = 'Ctrl + 单击打开链接';
    link.onclick = event => { event.preventDefault(); if (event.ctrlKey || event.metaKey) context.openLink(link.href); };
  }
  if (node.children) node.children.forEach(child => inline(child, element, context, definitions, depth + 1));
  else element.append(document.createTextNode(node.value ?? ''));
  if (element !== parent) parent.append(element);
}
class TableWidget extends WidgetType {
  constructor(readonly node: Node, readonly source: string, readonly context: MarkdownContext, readonly definitions: Map<string, Node>) { super(); }
  eq(other: TableWidget) {
    return start(this.node) === start(other.node) && this.source === other.source
      && this.context.target.kind === other.context.target.kind && this.context.target.id === other.context.target.id
      && JSON.stringify(this.context.assets) === JSON.stringify(other.context.assets)
      && JSON.stringify([...this.definitions].map(([id, node]) => [id, node.url])) === JSON.stringify([...other.definitions].map(([id, node]) => [id, node.url]));
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div'); wrap.className = 'cm-md-table'; wrap.tabIndex = 0; wrap.title = '点击单元格编辑表格';
    wrap.setAttribute('aria-label', 'Markdown 表格，点击编辑');
    const table = document.createElement('table');
    this.node.children?.forEach((row, rowIndex) => {
      const tr = document.createElement('tr');
      row.children?.forEach((cell, index) => {
        const td = document.createElement(rowIndex ? 'td' : 'th'); td.style.textAlign = this.node.align?.[index] ?? 'left';
        cell.children?.forEach(child => inline(child, td, this.context, this.definitions));
        td.onmousedown = event => {
          if ((event.ctrlKey || event.metaKey) && (event.target as HTMLElement).closest('a')) return;
          event.preventDefault(); activate(view, cell.children?.[0] ? start(cell.children[0]) : start(cell));
        };
        tr.append(td);
      }); table.append(tr);
    });
    wrap.append(table); wrap.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); activate(view, start(this.node) + 1); } };
    return wrap;
  }
  ignoreEvent() { return true; }
}
class RuleWidget extends WidgetType {
  constructor(readonly from: number) { super(); }
  eq(other: RuleWidget) { return this.from === other.from; }
  toDOM(view: EditorView) { const hr = document.createElement('hr'); hr.className = 'cm-md-rule'; hr.onmousedown = event => { event.preventDefault(); activate(view, this.from); }; return hr; }
  ignoreEvent() { return true; }
}

function presentation(state: EditorState, tree: Node, focused: boolean, context: MarkdownContext): DecorationSet {
  const ranges: Range<Decoration>[] = [], lines = new Map<number, Set<string>>(), hidden: [number, number][] = [];
  const source = state.doc.toString(); const definitions = new Map<string, Node>();
  const pending = [tree];
  while (pending.length) { const node = pending.pop()!; if (node.type === 'definition' && node.identifier) definitions.set(node.identifier, node); if (node.children) pending.push(...node.children); }
  const active = (from: number, to: number) => focused && state.selection.ranges.some(range => range.from <= to && range.to >= from);
  const hide = (from: number, to: number) => { if (to > from) hidden.push([from, to]); };
  const mark = (from: number, to: number, className: string, attributes?: Record<string, string>) => { if (to > from) ranges.push(Decoration.mark({ class: className, attributes }).range(from, to)); };
  const lineClass = (position: number, className: string) => { const from = state.doc.lineAt(position).from; const classes = lines.get(from) ?? new Set(); classes.add(className); lines.set(from, classes); };
  function visit(node: Node, depth = 0) {
    if (depth > 200) return; // Leave unusually deep structures as editable source.
    const from = start(node), to = end(node), raw = source.slice(from, to), editing = active(from, to);
    const first = node.children?.[0], last = node.children?.at(-1);
    const wholeLines = state.doc.lineAt(from).from === from && state.doc.lineAt(to).to === to;
    if (node.type === 'table' && !editing && wholeLines) {
      ranges.push(Decoration.replace({ widget: new TableWidget(node, raw, context, definitions), block: true }).range(from, to)); return;
    }
    if (node.type === 'image' || node.type === 'imageReference') {
      const resolved = node.type === 'imageReference' ? definitions.get(node.identifier ?? '') : node;
      if (resolved && !editing) ranges.push(Decoration.replace({ widget: new ImageWidget(from, markdownImageURL(resolved.url ?? '', context), node.alt ?? '') }).range(from, to));
      return;
    }
    if (node.type === 'thematicBreak' && !editing && wholeLines) { ranges.push(Decoration.replace({ widget: new RuleWidget(from), block: true }).range(from, to)); return; }
    if (node.type === 'heading') {
      lineClass(from, `cm-md-heading cm-md-h${node.depth}`);
      if (!editing && first && last) { hide(from, start(first)); hide(end(last), to); }
    }
    const inlineClass = ({ strong: 'cm-md-strong', emphasis: 'cm-md-em', delete: 'cm-md-strike' } as Record<string, string>)[node.type];
    if (inlineClass) {
      mark(from, to, inlineClass);
      if (!editing && first && last) { hide(from, start(first)); hide(end(last), to); }
    }
    if (node.type === 'inlineCode') {
      mark(from, to, 'cm-md-inline-code');
      const delimiter = raw.match(/^`+/)?.[0].length ?? 0;
      if (!editing && delimiter) { hide(from, from + delimiter); hide(to - delimiter, to); }
    }
    if (node.type === 'link' || node.type === 'linkReference') {
      const url = node.url ?? definitions.get(node.identifier ?? '')?.url ?? '';
      if (/^https?:\/\//i.test(url)) mark(from, to, 'cm-md-link', { 'data-md-link': url, title: 'Ctrl + 单击打开链接' });
      if (!editing && first && last && url) { hide(from, start(first)); hide(end(last), to); }
    }
    if (node.type === 'listItem') {
      const prefix = raw.match(/^(?:[*+-]|\d+[.)])\s+(?:\[([ xX])\]\s+)?/);
      if (prefix && !active(from, from + prefix[0].length)) {
        const taskOffset = prefix[0].indexOf('[');
        const widget = typeof node.checked === 'boolean' && taskOffset >= 0
          ? new CheckWidget(from + taskOffset + 1, node.checked, context.disabled)
          : new BulletWidget(/^\d/.test(prefix[0]) ? prefix[0].trim() : '•');
        ranges.push(Decoration.replace({ widget }).range(from, from + prefix[0].length));
      }
    }
    if (['blockquote', 'code', 'table'].includes(node.type)) {
      const firstLine = state.doc.lineAt(from).number, lastLine = state.doc.lineAt(to).number;
      for (let number = firstLine; number <= lastLine; number++) {
        const line = state.doc.line(number); lineClass(line.from, node.type === 'blockquote' ? 'cm-md-quote' : node.type === 'table' ? 'cm-md-table-source' : 'cm-md-code');
        if (node.type === 'blockquote' && !active(line.from, line.to)) {
          const prefix = line.text.match(/^\s*> ?/); if (prefix) hide(line.from, line.from + prefix[0].length);
        }
      }
      if (node.type === 'code' && !editing) {
        const fence = state.doc.lineAt(from); if (/^\s*(`{3,}|~{3,})/.test(fence.text)) {
          hide(from, fence.to); const closing = state.doc.lineAt(to); if (closing.number !== fence.number && /^\s*(`{3,}|~{3,})\s*$/.test(closing.text)) hide(closing.from, to);
        }
      }
    }
    node.children?.forEach(child => visit(child, depth + 1));
  }
  tree.children?.forEach(node => visit(node));
  for (const [from, classes] of lines) ranges.push(Decoration.line({ class: [...classes].join(' ') }).range(from));
  // Nested blocks can hide the same prefix. Merge those ranges before passing
  // them to the editor; the document itself always remains unchanged.
  hidden.sort((a, b) => a[0] - b[0]); const merged: [number, number][] = [];
  for (const range of hidden) { const previous = merged.at(-1); if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]); else merged.push([...range]); }
  for (const [from, to] of merged) ranges.push(Decoration.replace({}).range(from, to));
  return Decoration.set(ranges, true);
}

export function liveMarkdown(context: () => MarkdownContext): Extension {
  function render(state: EditorState, focused: boolean, existing?: Node) {
    try { const tree = existing ?? parseMarkdown(state.doc.toString()); return { tree, focused, decorations: presentation(state, tree, focused, context()) }; }
    catch {
      queueMicrotask(() => context().onError?.('这段内容的实时排版暂不可用，可切换源码继续编辑。'));
      return { tree: { type: 'root', children: [] }, focused, decorations: Decoration.none };
    }
  }
  const field = StateField.define<{ tree: Node; focused: boolean; decorations: DecorationSet }>({
    create(state) { return render(state, false); },
    update(value, transaction) {
      let focused = value.focused;
      for (const effect of transaction.effects) if (effect.is(focusMarkdown)) focused = effect.value;
      if (!transaction.docChanged && !transaction.selection && focused === value.focused && !transaction.effects.some(effect => effect.is(refreshMarkdown))) return value;
      return render(transaction.state, focused, transaction.docChanged ? undefined : value.tree);
    },
    provide: field => EditorView.decorations.from(field, value => value.decorations),
  });
  return [field, EditorView.focusChangeEffect.of((_state, focusing) => focusMarkdown.of(focusing)), EditorView.domEventHandlers({
    click(event) {
      const link = (event.target as HTMLElement).closest<HTMLElement>('[data-md-link]');
      if (link && (event.ctrlKey || event.metaKey)) { event.preventDefault(); context().openLink(link.dataset.mdLink!); return true; }
      return false;
    },
  })];
}
