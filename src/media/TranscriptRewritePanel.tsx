import { useEffect, useState } from 'react';
import { generateAgentText } from '../agent/client';
import { Icon } from '../components/icons';
import { useT } from '../i18n/locale';
import {
  buildTranscriptRewritePrompt,
  cleanTranscriptRewriteResult,
  TRANSCRIPT_REWRITE_MAX_CHARS,
  TRANSCRIPT_REWRITE_MODES,
  type TranscriptRewriteMode,
} from './transcriptRewrite';

interface TranscriptRewritePanelProps {
  readonly sourceText: string;
  readonly sourceId: string;
}

export function TranscriptRewritePanel({ sourceText, sourceId }: TranscriptRewritePanelProps) {
  const t = useT();
  const [rewriteMode, setRewriteMode] = useState<TranscriptRewriteMode>('natural');
  const [customInstruction, setCustomInstruction] = useState('');
  const [rewrittenText, setRewrittenText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setRewrittenText('');
    setError('');
    setCopied(false);
  }, [sourceId]);

  const copy = async () => {
    if (!rewrittenText.trim()) return;
    try {
      await navigator.clipboard.writeText(rewrittenText.trim());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Keep the generated textarea selectable when clipboard access is unavailable.
    }
  };

  const generate = async () => {
    if (!sourceText.trim() || busy) return;
    if (sourceText.length > TRANSCRIPT_REWRITE_MAX_CHARS) {
      setError(t('文字稿过长，请先精简到 8 万字以内再改写'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await generateAgentText({
        system: '你是 AI-cut 的专业视频文案编辑。忠实保留来源事实，只执行用户选择的文案改写任务。',
        prompt: buildTranscriptRewritePrompt(sourceText, rewriteMode, customInstruction),
        maxOutputTokens: 16_384,
      });
      const cleaned = cleanTranscriptRewriteResult(result);
      if (!cleaned) throw new Error(t('AI 没有返回改写结果'));
      setRewrittenText(cleaned);
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : t('AI 改写失败，请稍后重试'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cc-transcript-rewrite">
      <div className="cc-transcript-rewrite-heading">
        <div>
          <strong>{t('AI 文案改写')}</strong>
          <span>{t('使用平台云端模型，原文字稿不会被覆盖')}</span>
        </div>
        <span>{sourceText.length.toLocaleString()} {t('字')}</span>
      </div>
      <div className="cc-transcript-rewrite-modes" role="group" aria-label={t('改写方向')}>
        {TRANSCRIPT_REWRITE_MODES.map((option) => (
          <button
            type="button"
            key={option.value}
            className={rewriteMode === option.value ? 'active' : ''}
            aria-pressed={rewriteMode === option.value}
            onClick={() => setRewriteMode(option.value)}
          >{t(option.label)}</button>
        ))}
      </div>
      <input
        type="text"
        value={customInstruction}
        disabled={busy}
        maxLength={500}
        placeholder={t('补充要求（可选），例如：面向新手、控制在 300 字')}
        onChange={(event) => setCustomInstruction(event.target.value)}
      />
      <button type="button" className="cc-transcript-rewrite-generate" disabled={busy} onClick={() => void generate()}>
        <Icon name="sparkles" size={14} />
        {busy ? t('正在改写…') : rewrittenText ? t('重新生成') : t('生成改写文案')}
      </button>
      {error && <p className="cc-transcript-rewrite-error" role="alert">{error}</p>}
      {rewrittenText && (
        <div className="cc-transcript-rewrite-result">
          <div>
            <strong>{t('改写结果')}</strong>
            <button type="button" onClick={() => void copy()}>
              <Icon name="copy" size={13} />{copied ? t('已复制') : t('复制结果')}
            </button>
          </div>
          <textarea
            value={rewrittenText}
            aria-label={t('改写结果')}
            onChange={(event) => setRewrittenText(event.target.value)}
          />
        </div>
      )}
    </div>
  );
}
