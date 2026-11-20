import { useEffect, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { boardAssetURL } from '../shared/board';

export default function BoardImage({ id, name, fit, revision }: { id: string; name: string; fit: 'cover' | 'contain'; revision: string | null }) {
  const [failed, setFailed] = useState(false);
  const failedRef = useRef(false); failedRef.current = failed;
  const [attempt, setAttempt] = useState(0);
  const retry = () => { setFailed(false); setAttempt(value => value + 1); };
  useEffect(() => { if (failedRef.current) retry(); }, [id, revision]);
  return failed ? <div className="board-image-missing"><ImageOff size={24} /><span>{name}尚未同步或无法读取</span><button type="button" onClick={retry}>重试加载</button></div>
    : <img src={`${boardAssetURL(id)}?retry=${attempt}`} alt={name} draggable={false} style={{ objectFit: fit }} onError={() => setFailed(true)} />;
}
