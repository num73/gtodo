import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { assetURL, normalizeAssetPath, type AssetMap, type DocumentTarget } from '../shared/documents';

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return !src || failed ? <span className="document-image-missing" role="img" aria-label={alt || '图片'}>{alt || '图片'} · 图片暂不可用</span>
    : <img src={src} alt={alt ?? ''} loading="lazy" onError={() => setFailed(true)} />;
}

export default function MarkdownPreview({ value, label, target, assets, openLink }: {
  value: string; label: string; target: DocumentTarget; assets: AssetMap; openLink: (url: string) => void;
}) {
  return <div className="markdown-preview" aria-label={`${label}预览`}>
    <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false }]]} skipHtml urlTransform={(url, key) => {
      if (key === 'src') { const relative = normalizeAssetPath(url); return relative ? assetURL(target, relative, assets[relative]) : /^https:\/\//i.test(url) ? url : ''; }
      return /^https?:\/\//i.test(url) ? url : '';
    }} components={{
      img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
      a: ({ href, children }) => href ? <a href={href} onClick={event => { event.preventDefault(); openLink(href); }}>{children}</a> : <span>{children}</span>,
    }}>{value || '*暂无内容*'}</Markdown>
  </div>;
}
