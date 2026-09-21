import { useRef, useState } from 'react';
import { Icon } from '../components/icons';
import { useT } from '../i18n/locale';
import { TranscriptRewritePanel } from '../media/TranscriptRewritePanel';
import { extractVideoCopy, extractVideoLink } from '../media/videoCopyRewrite';
import { videoLinkPlatform, VIDEO_LINK_PLATFORM_LABELS } from '../../shared/video-link-resolver';

export function VideoCopyRewritePanel() {
  const t = useT();
  const [link, setLink] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [sourceGeneration, setSourceGeneration] = useState(0);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const extracting = useRef(false);
  const [copied, setCopied] = useState(false);
  const platform = videoLinkPlatform(link);

  const extract = async (value = link) => {
    if (!value.trim() || extracting.current) return;
    extracting.current = true;
    setBusy(true);
    setError('');
    setProgress(t('正在解析视频链接…'));
    setSourceText('');
    setSourceName('');
    try {
      const result = await extractVideoCopy(value, (message) => setProgress(t(message)));
      setSourceName(result.video.name);
      setSourceText(result.text);
      setSourceGeneration((generation) => generation + 1);
      setProgress('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setProgress('');
    } finally {
      extracting.current = false;
      setBusy(false);
    }
  };

  const copySource = async () => {
    if (!sourceText.trim()) return;
    try {
      await navigator.clipboard.writeText(sourceText.trim());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // The textarea remains selectable if clipboard permission is unavailable.
    }
  };

  return (
    <div className="cc-video-copy-rewrite">
      <header className="cc-video-copy-rewrite-hero">
        <span><Icon name="sparkles" size={18} /></span>
        <div>
          <strong>{t('视频文案提取与 AI 改写')}</strong>
          <small>{t('粘贴视频链接，本地 Whisper 提取语音文案，再使用平台 AI 完成改写')}</small>
        </div>
      </header>

      <section className="cc-video-copy-step">
        <div className="cc-video-copy-step-title"><b>1</b><span>{t('输入视频链接')}</span></div>
        <textarea
          value={link}
          disabled={busy}
          aria-label={t('视频链接')}
          placeholder={t('粘贴抖音、小红书、微信视频号分享链接或完整分享内容…')}
          onChange={(event) => setLink(event.target.value)}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData('text/plain');
            if (!extractVideoLink(pasted) || extracting.current) return;
            event.preventDefault();
            // A complete pasted share replaces the previous link, so another
            // video's stale URL cannot accidentally be extracted again.
            setLink(pasted);
            void extract(pasted);
          }}
        />
        <small>{t('粘贴分享链接后自动解析，语音文案在本机识别。')}</small>
        {platform === 'wechat' && <small>{t('视频号必要时使用 BugPk 免费解析，仅发送公开分享链接，无需登录；音视频下载及转写在本机完成。')}</small>}
        {link.trim() && platform !== 'other' && <small>{t('已识别平台')}：{t(VIDEO_LINK_PLATFORM_LABELS[platform])}</small>}
        <button
          type="button"
          className={`cc-video-copy-primary${busy ? ' is-busy' : ''}`}
          disabled={busy || !link.trim()}
          aria-busy={busy}
          onClick={() => void extract()}
        >
          <Icon name={busy ? 'refresh' : 'wand'} size={14} />
          {busy ? progress || t('正在提取…') : t('提取视频文案')}
        </button>
        {error && <p className="cc-video-copy-error" role="alert">{error}</p>}
      </section>

      {sourceText && (
        <>
          <section className="cc-video-copy-step">
            <div className="cc-video-copy-step-title">
              <b>2</b><span>{t('检查提取文案')}</span>
              <button type="button" onClick={() => void copySource()}><Icon name="copy" size={12} />{copied ? t('已复制') : t('复制')}</button>
            </div>
            <div className="cc-video-copy-source-meta">
              <span title={sourceName}>{sourceName}</span><span>{sourceText.length.toLocaleString()} {t('字')}</span>
            </div>
            <textarea
              className="cc-video-copy-source"
              value={sourceText}
              aria-label={t('提取出的原始文案')}
              onChange={(event) => setSourceText(event.target.value)}
            />
          </section>
          <section className="cc-video-copy-step">
            <div className="cc-video-copy-step-title"><b>3</b><span>{t('AI 改写')}</span></div>
            <TranscriptRewritePanel sourceText={sourceText} sourceId={`video-link:${sourceGeneration}`} />
          </section>
        </>
      )}
    </div>
  );
}
