import { useEffect, useRef, useState } from 'react';
import client from '../api/client.js';
import { unsealBytes } from '../crypto/keys.js';
import { attachmentIdOf, normalizeAttachment, pickAttachmentEnvelope } from '../crypto/voiceCache.js';
import { useNotificationSettings } from '../context/NotificationSettingsContext.jsx';
import VoicePlayer from './VoicePlayer.jsx';

function FileIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function MicIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function DownloadIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function SaveIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  );
}

// The Network Information API (navigator.connection) is Chrome/Android-only —
// iOS Safari and Firefox don't expose it. When unsupported, default to
// allowing auto-download rather than silently blocking it forever on
// browsers that can't report connection type.
function isOnWifi() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn || !conn.type) return true;
  return conn.type === 'wifi' || conn.type === 'ethernet';
}

function kindOf(attachment) {
  const mime = (attachment?.mimetype || '').toLowerCase();
  const name = (attachment?.filename || '').toLowerCase();
  if (mime.startsWith('video/')) {
    return 'video';
  }
  if (mime.startsWith('audio/') || /^voice-note/i.test(name)) {
    return 'audio';
  }
  if (mime === 'image/svg+xml' || name.endsWith('.svg')) return 'file';
  if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) return 'image';
  if (/\.(mp4|webm|mov|mkv|avi)$/i.test(name)) return 'video';
  if (/\.(ogg|mp3|m4a|wav|aac)$/i.test(name)) return 'audio';
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (
    mime.includes('word') ||
    mime.includes('officedocument.wordprocessing') ||
    /\.(docx?|odt|rtf)$/i.test(name)
  ) {
    return 'word';
  }
  if (mime.includes('zip') || mime.includes('compressed') || /\.(zip|rar|7z|tar|gz)$/i.test(name)) {
    return 'zip';
  }
  if (mime.startsWith('text/') || /\.(txt|md|csv|json|log)$/i.test(name)) return 'text';
  return 'file';
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function typeLabel(kind) {
  if (kind === 'pdf') return 'PDF';
  if (kind === 'word') return 'Word';
  if (kind === 'zip') return 'Archive';
  if (kind === 'text') return 'Text';
  if (kind === 'video') return 'Video';
  if (kind === 'image') return 'Image';
  if (kind === 'audio') return 'Audio';
  return 'File';
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  a.click();
}

export default function AttachmentBubble({
  attachment: rawAttachment,
  isMine,
  resolveSecretKey,
  resolveAttachmentKey,
  onImagePreview,
  onImageReady,
  onVideoPreview,
  onVideoReady,
  viewOnce = false,
  viewOnceOpened = false,
  viewOnceMediaKind = null,
  onBurnViewOnce,
}) {
  const attachment = normalizeAttachment(rawAttachment);
  const [status, setStatus] = useState('idle');
  const [objectUrl, setObjectUrl] = useState(null);
  const [textPreview, setTextPreview] = useState(null);
  const [pdfExpanded, setPdfExpanded] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const burnedRef = useRef(false);
  const kind = viewOnceMediaKind || kindOf(attachment);
  const attachmentId = attachmentIdOf(attachment);
  const keyResolver = resolveSecretKey || resolveAttachmentKey;
  const opened = pickAttachmentEnvelope(attachment, keyResolver);
  const isViewOncePending = viewOnce && !viewOnceOpened;
  const { settings: notifSettings } = useNotificationSettings();
  const media = notifSettings?.mediaSettings || {};
  const wifiOk = media.wifiOnly === false ? true : isOnWifi();
  const imageAutoOk = media.autoDownloadImages !== false && wifiOk;
  const videoAutoOk = media.autoDownloadVideos === true && wifiOk;
  const autoPreview =
    !isViewOncePending &&
    (kind === 'audio' ||
      kind === 'pdf' ||
      kind === 'text' ||
      (kind === 'image' && imageAutoOk) ||
      (kind === 'video' && videoAutoOk));

  async function burn() {
    if (burnedRef.current || !onBurnViewOnce) return;
    burnedRef.current = true;
    try {
      await onBurnViewOnce();
    } catch {
      burnedRef.current = false;
    }
  }

  async function decryptToUrl() {
    if (!attachmentId || !opened) throw new Error('Cannot decrypt');
    const res = await client.get(`/attachments/${attachmentId}/raw`, { responseType: 'arraybuffer' });
    const plainBytes = unsealBytes(new Uint8Array(res.data), opened.envelope, opened.secretKey);
    if (!plainBytes) throw new Error('Decrypt failed');
    const mime =
      attachment.mimetype ||
      (kind === 'audio'
        ? 'audio/webm'
        : kind === 'image'
          ? 'image/jpeg'
          : kind === 'video'
            ? 'video/mp4'
            : 'application/octet-stream');
    return URL.createObjectURL(new Blob([plainBytes], { type: mime }));
  }

  async function openViewOnce() {
    if (!isViewOncePending || !opened) return;
    setStatus('loading');
    try {
      const url = await decryptToUrl();
      setObjectUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
      setUnlocked(true);
      setStatus('idle');
      if (kind === 'image') {
        setViewerOpen(true);
      }
    } catch {
      setStatus('error');
    }
  }

  function closeViewOnceViewer() {
    setViewerOpen(false);
    burn();
  }

  useEffect(() => {
    let revoked = null;
    let cancelled = false;

    async function load() {
      if (!autoPreview || !attachmentId || !opened) return;

      setStatus('loading');
      try {
        const res = await client.get(`/attachments/${attachmentId}/raw`, { responseType: 'arraybuffer' });
        if (cancelled) return;
        const plainBytes = unsealBytes(new Uint8Array(res.data), opened.envelope, opened.secretKey);
        if (!plainBytes) {
          setStatus('error');
          return;
        }

        const mime =
          attachment.mimetype ||
          (kind === 'audio'
            ? 'audio/webm'
            : kind === 'pdf'
              ? 'application/pdf'
              : kind === 'image'
                ? 'image/jpeg'
                : kind === 'video'
                  ? 'video/mp4'
                  : kind === 'text'
                    ? 'text/plain'
                    : 'application/octet-stream');

        if (kind === 'text') {
          const text = new TextDecoder().decode(plainBytes).slice(0, 4000);
          setTextPreview(text);
          const url = URL.createObjectURL(new Blob([plainBytes], { type: mime }));
          revoked = url;
          setObjectUrl(url);
        } else {
          const url = URL.createObjectURL(new Blob([plainBytes], { type: mime }));
          revoked = url;
          setObjectUrl(url);
          if (kind === 'image' && onImageReady) {
            onImageReady(attachmentId, url, attachment.filename);
          }
          if (kind === 'video' && onVideoReady) {
            onVideoReady(attachmentId, url, attachment.filename);
          }
        }
        setStatus('idle');
      } catch {
        if (!cancelled) setStatus('error');
      }
    }

    load();
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [
    autoPreview,
    attachmentId,
    opened?.secretKey,
    opened?.envelope?.nonce,
    opened?.envelope?.targetPublicKey,
    attachment?.mimetype,
    attachment?.filename,
    kind,
  ]);

  async function handleManualOpen() {
    setStatus('loading');
    try {
      const res = await client.get(`/attachments/${attachmentId}/raw`, { responseType: 'arraybuffer' });
      const plainBytes = unsealBytes(new Uint8Array(res.data), opened.envelope, opened.secretKey);
      if (!plainBytes) {
        setStatus('error');
        return;
      }
      const mime = attachment.mimetype || 'application/octet-stream';
      const blob = new Blob([plainBytes], { type: mime });
      const url = URL.createObjectURL(blob);
      setObjectUrl(url);
      triggerDownload(url, attachment.filename);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  }

  function handleDownload() {
    if (objectUrl) {
      triggerDownload(objectUrl, attachment.filename);
      return;
    }
    handleManualOpen();
  }

  // True "save to Photos/Camera Roll" requires the native share sheet — no
  // browser API can write directly into the device gallery silently. This
  // is a one-tap flow: share sheet opens, user picks "Save Image"/"Save
  // Video". Falls back to a normal file download where Web Share (or
  // sharing files specifically) isn't supported, e.g. most desktop browsers.
  async function handleSaveToPhotos() {
    const url = objectUrl;
    if (!url) return;
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const ext = kind === 'video' ? 'mp4' : 'jpg';
      const file = new File([blob], attachment.filename || `quantumchat-media.${ext}`, {
        type: blob.type,
      });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
      triggerDownload(url, attachment.filename);
    } catch (err) {
      if (err?.name !== 'AbortError') {
        triggerDownload(url, attachment.filename);
      }
    }
  }

  if (!attachment && !viewOnceOpened) return null;

  if (viewOnce && viewOnceOpened) {
    const label =
      kind === 'video' ? 'Video' : kind === 'audio' ? 'Voice note' : 'Photo';
    return (
      <div className="view-once-tombstone" aria-label={`${label} opened`}>
        <span className="view-once-tombstone-icon" aria-hidden="true">
          {kind === 'audio' ? <MicIcon className="file-icon" /> : kind === 'video' ? '▶' : '📷'}
        </span>
        <span>
          <strong>{label}</strong>
          <span className="view-once-tombstone-sub">Opened · removed</span>
        </span>
      </div>
    );
  }

  if (!attachment) return null;

  if (!opened) {
    return (
      <div className="attachment-chip attachment-chip-disabled">
        <span className="attachment-filename">
          {kind === 'audio' ? <MicIcon className="file-icon" /> : <FileIcon className="file-icon" />}
          <span>{kind === 'audio' ? 'Voice note' : attachment.filename}</span>
        </span>
        <span className="attachment-note">
          {status === 'loading'
            ? 'Decrypting…'
            : isMine
              ? 'only the recipient can open this'
              : "can't decrypt on this device"}
        </span>
      </div>
    );
  }

  if (isViewOncePending && !unlocked) {
    const label =
      kind === 'video' ? 'Video' : kind === 'audio' ? 'Voice note' : 'Photo';
    if (isMine) {
      return (
        <div className="view-once-lock mine">
          <span className="view-once-lock-badge" aria-hidden="true">1</span>
          <span className="view-once-lock-body">
            <strong>View once {label.toLowerCase()}</strong>
            <span>Waiting to be opened · opens once</span>
          </span>
        </div>
      );
    }
    return (
      <button
        type="button"
        className="view-once-lock"
        onClick={openViewOnce}
        disabled={status === 'loading'}
      >
        <span className="view-once-lock-badge" aria-hidden="true">1</span>
        <span className="view-once-lock-body">
          <strong>Tap to view {label.toLowerCase()}</strong>
          <span>Opens once, then disappears</span>
        </span>
        {status === 'loading' ? <span className="view-once-lock-status">Opening…</span> : null}
        {status === 'error' ? <span className="view-once-lock-status error">Failed — retry</span> : null}
      </button>
    );
  }

  if (isViewOncePending && unlocked && objectUrl) {
    if (kind === 'audio') {
      return <VoicePlayer url={objectUrl} onPlayedThrough={burn} />;
    }
    if (kind === 'video') {
      return (
        <div className="attachment-media view-once-media">
          <video
            className="attachment-video"
            src={objectUrl}
            controls
            playsInline
            autoPlay
            preload="metadata"
            onEnded={burn}
          />
          <button type="button" className="view-once-done-btn" onClick={burn}>
            Done · remove
          </button>
        </div>
      );
    }
    return (
      <>
        <div className="attachment-media view-once-media">
          <img
            className="attachment-preview"
            src={objectUrl}
            alt="View once photo"
            onClick={() => setViewerOpen(true)}
            role="button"
          />
          <button type="button" className="view-once-done-btn" onClick={burn}>
            Done · remove
          </button>
        </div>
        {viewerOpen ? (
          <div className="lightbox-overlay" role="dialog" aria-modal="true" onClick={closeViewOnceViewer}>
            <button type="button" className="lightbox-close" onClick={closeViewOnceViewer} aria-label="Close">
              ✕
            </button>
            <img src={objectUrl} alt="View once photo" className="lightbox-image" onClick={(e) => e.stopPropagation()} />
          </div>
        ) : null}
      </>
    );
  }

  if (kind === 'audio' && objectUrl) {
    return <VoicePlayer url={objectUrl} onPlayedThrough={viewOnce ? onBurnViewOnce : undefined} isMine={isMine} />;
  }

  if (kind === 'image' && objectUrl) {
    return (
      <div className="attachment-media">
        <img
          className="attachment-preview"
          src={objectUrl}
          alt={attachment.filename}
          loading="lazy"
          decoding="async"
          onClick={() => onImagePreview?.(attachmentId, objectUrl, attachment.filename)}
          role="button"
          aria-label="Open image gallery"
        />
        {!viewOnce && (
          <div className="attachment-media-actions">
            <button type="button" className="attachment-download-fab" onClick={handleSaveToPhotos} aria-label="Save to Photos">
              <SaveIcon className="file-icon" />
            </button>
            <button type="button" className="attachment-download-fab" onClick={handleDownload} aria-label="Download image">
              <DownloadIcon className="file-icon" />
            </button>
          </div>
        )}
      </div>
    );
  }

  if (kind === 'video' && objectUrl) {
    return (
      <div className="attachment-media">
        <video className="attachment-video" src={objectUrl} controls playsInline preload="metadata" />
        {!viewOnce && (
          <div className="attachment-media-actions">
            <button type="button" className="attachment-download-fab" onClick={handleSaveToPhotos} aria-label="Save to Photos">
              <SaveIcon className="file-icon" />
            </button>
            <button type="button" className="attachment-download-fab" onClick={handleDownload} aria-label="Download video">
              <DownloadIcon className="file-icon" />
            </button>
          </div>
        )}
      </div>
    );
  }

  if (kind === 'pdf' && objectUrl) {
    return (
      <div className="attachment-doc">
        <div className="attachment-doc-header">
          <span className="attachment-type-badge">PDF</span>
          <span className="attachment-filename-text">{attachment.filename}</span>
          {attachment.size ? <span className="attachment-note">({formatFileSize(attachment.size)})</span> : null}
        </div>
        {pdfExpanded ? (
          <iframe
            className="attachment-pdf"
            src={objectUrl}
            title={attachment.filename}
            sandbox="allow-same-origin"
          />
        ) : (
          <button type="button" className="attachment-pdf-thumb" onClick={() => setPdfExpanded(true)}>
            <FileIcon className="file-icon" />
            <span>Preview PDF</span>
          </button>
        )}
        <div className="attachment-doc-actions">
          {!pdfExpanded && (
            <button type="button" onClick={() => setPdfExpanded(true)}>
              Preview
            </button>
          )}
          <button type="button" onClick={handleDownload}>
            Download
          </button>
        </div>
      </div>
    );
  }

  if (kind === 'text' && (textPreview != null || objectUrl)) {
    return (
      <div className="attachment-doc">
        <div className="attachment-doc-header">
          <span className="attachment-type-badge">TXT</span>
          <span className="attachment-filename-text">{attachment.filename}</span>
        </div>
        {textPreview != null && <pre className="attachment-text-preview">{textPreview}</pre>}
        <div className="attachment-doc-actions">
          <button type="button" onClick={handleDownload}>
            Download
          </button>
        </div>
      </div>
    );
  }

  if (status === 'loading' && autoPreview) {
    if (kind === 'audio') {
      return (
        <div className="attachment-chip attachment-chip-voice">
          <span className="attachment-filename">
            <MicIcon className="file-icon" />
            <span>Decrypting voice note…</span>
          </span>
        </div>
      );
    }
    return <div className="skeleton attachment-preview-placeholder" />;
  }

  if (status === 'error' && autoPreview) {
    return (
      <div className="attachment-chip">
        <span className="attachment-filename">
          <FileIcon className="file-icon" />
          <span>{attachment.filename}</span>
        </span>
        <button type="button" onClick={handleManualOpen}>
          Retry download
        </button>
      </div>
    );
  }

  return (
    <div className={`attachment-chip ${kind === 'audio' ? 'attachment-chip-voice' : ''}`}>
      <span className="attachment-filename">
        {kind === 'audio' ? <MicIcon className="file-icon" /> : <FileIcon className="file-icon" />}
        <span className="attachment-type-badge">{typeLabel(kind)}</span>
        <span>{kind === 'audio' ? 'Voice note' : attachment.filename}</span>
        {attachment.size ? <span className="attachment-note">({formatFileSize(attachment.size)})</span> : null}
      </span>
      <button type="button" onClick={handleManualOpen} disabled={status === 'loading'}>
        {status === 'loading' ? 'Decrypting…' : status === 'error' ? 'Failed — retry' : 'Download'}
      </button>
    </div>
  );
}
