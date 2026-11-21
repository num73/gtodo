export const markdownFormats = [
  { id: 'h1', label: '一级标题' }, { id: 'h2', label: '二级标题' }, { id: 'h3', label: '三级标题' },
  { id: 'bold', label: '加粗' }, { id: 'italic', label: '斜体' }, { id: 'strike', label: '删除线' }, { id: 'inline', label: '行内代码' },
  { id: 'bullet', label: '无序列表' }, { id: 'ordered', label: '有序列表' }, { id: 'check', label: '勾选清单' }, { id: 'quote', label: '引用' },
] as const;
export type MarkdownFormat = typeof markdownFormats[number]['id'];
export function markdownEdit(value: string, start: number, end: number, format: MarkdownFormat) {
  const markers: Partial<Record<MarkdownFormat, string>> = { bold: '**', italic: '*', strike: '~~', inline: '`' };
  const marker = markers[format];
  if (marker) {
    const outside = start >= marker.length && value.slice(start - marker.length, start) === marker && value.slice(end, end + marker.length) === marker;
    const text = value.slice(start, end);
    return outside ? { from: start - marker.length, to: end + marker.length, text, selectFrom: start - marker.length, selectTo: end - marker.length }
      : { from: start, to: end, text: marker + text + marker, selectFrom: start + marker.length, selectTo: end + marker.length };
  }
  const from = start ? value.lastIndexOf('\n', start - 1) + 1 : 0;
  const boundary = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const nextLine = value.indexOf('\n', boundary), to = nextLine < 0 ? value.length : nextLine;
  const lines = value.slice(from, to).split('\n');
  const strip = /^(?:#{1,6}\s+|>\s?|(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/;
  const prefix = (index: number) => format === 'h1' ? '# ' : format === 'h2' ? '## ' : format === 'h3' ? '### ' : format === 'quote' ? '> ' : format === 'check' ? '- [ ] ' : format === 'ordered' ? `${index + 1}. ` : '- ';
  const remove = lines.every((line, index) => line.startsWith(prefix(index)));
  const text = lines.map((line, index) => remove ? line.slice(prefix(index).length) : prefix(index) + line.replace(strip, '')).join('\n');
  return { from, to, text, selectFrom: from, selectTo: from + text.length };
}
