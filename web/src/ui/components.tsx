import { useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from 'react';
import { ApiError, postEvent } from '../api/client';
import type { EventStatus, PostEventBody, PostEventResponse } from '../api/schema';
import { OUTCOME_LABEL, SOURCE_LABEL, STATUS_LABEL, type RunOutcome } from './derive';

export function StatusBadge({ status }: { status: EventStatus }) {
  return (
    <span className={`badge badge-${status}`}>
      {status === 'processing' && <span className="spinner" aria-hidden />}
      {STATUS_LABEL[status]}
    </span>
  );
}

export function OutcomeBadge({ outcome }: { outcome: RunOutcome }) {
  return (
    <span className={`badge badge-outcome-${outcome}`}>
      {outcome === 'running' && <span className="spinner" aria-hidden />}
      {OUTCOME_LABEL[outcome]}
    </span>
  );
}

export function SourceAvatar({ source }: { source: string }) {
  const label = SOURCE_LABEL[source] ?? source;
  return (
    <span className={`avatar avatar-${source}`} title={label} aria-label={label}>
      {source === 'user' ? 'あ' : label.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function AgentAvatar() {
  return (
    <span className="avatar avatar-agent" aria-label="エージェント">
      A
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <span>読み込みに失敗しました（{message}）。表示は前回の内容のままです。</span>
      <button type="button" className="btn btn-small" onClick={onRetry}>
        もう一度読み込む
      </button>
    </div>
  );
}

/**
 * メッセージの入力欄。送ると POST /users/{userId}/events に text（と sessionId）を送る。
 * Enter で改行、⌘/Ctrl + Enter で送信。
 */
export function Composer({
  userId,
  sessionId,
  placeholder,
  onSent,
  autoFocus,
}: {
  userId: string;
  sessionId?: string;
  placeholder: string;
  onSent: (res: PostEventResponse) => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  const send = async (e?: SyntheticEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(undefined);
    try {
      const req: PostEventBody = sessionId ? { text: body, sessionId } : { text: body };
      const res = await postEvent(userId, req);
      setText('');
      onSent(res);
    } catch (err) {
      setError(err instanceof ApiError ? `送れませんでした: ${err.message}` : '送れませんでした');
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
  };

  return (
    <form className="composer" onSubmit={(e) => void send(e)}>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={2}
        aria-label="メッセージ"
        autoFocus={autoFocus}
      />
      <div className="composer-row">
        <span className="hint">⌘/Ctrl + Enter で送信</span>
        {error && <span className="composer-error">{error}</span>}
        <button type="submit" className="btn btn-primary" disabled={!text.trim() || sending}>
          {sending ? '送信中…' : '送る'}
        </button>
      </div>
    </form>
  );
}

export function Toast({ children }: { children: ReactNode }) {
  return (
    <div className="toast" role="status">
      {children}
    </div>
  );
}
