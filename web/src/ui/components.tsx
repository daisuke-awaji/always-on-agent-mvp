import { ArrowUp, ChevronLeft, X } from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
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
 * Enter は改行（日本語の変換の確定とぶつからないように）。送るのはボタンか ⌘/Ctrl + Enter。
 * 1 行から始めて、書いた分だけ伸びる（上限は CSS の max-height）。
 */
export function Composer({
  userId,
  sessionId,
  placeholder,
  onSent,
}: {
  userId: string;
  sessionId?: string;
  placeholder: string;
  onSent: (res: PostEventResponse) => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    // 隠れているあいだ（スマホで一覧を出しているとき）は測れないので、rows=1 の高さのままにする
    if (el.scrollHeight > 0) el.style.height = `${String(el.scrollHeight)}px`;
  }, [text]);

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
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
  };

  return (
    <form className="composer" onSubmit={(e) => void send(e)}>
      {error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
      <div className="composer-box">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={1}
          aria-label="メッセージ"
        />
        <button
          type="submit"
          className="send-btn"
          disabled={!text.trim() || sending}
          aria-label={sending ? '送信中' : '送る'}
          title="送る（⌘/Ctrl + Enter）"
        >
          {sending ? <span className="spinner" aria-hidden /> : <ArrowUp size={18} strokeWidth={2.5} aria-hidden />}
        </button>
      </div>
    </form>
  );
}

/**
 * 一覧の右（スマホでは画面いっぱい）に出る詳細の見出し。
 * 戻るボタンはスマホのときだけ見せる（広い画面では一覧が横に見えているので要らない）。
 */
export function PaneHeader({
  title,
  sub,
  onBack,
  backLabel,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  children?: ReactNode;
}) {
  return (
    <header className="pane-head">
      {onBack && (
        <button type="button" className="icon-btn pane-back" onClick={onBack} aria-label={backLabel ?? '戻る'}>
          <ChevronLeft size={24} aria-hidden />
        </button>
      )}
      <div className="pane-title">
        <h2 className="ellipsis">{title}</h2>
        {sub && <p className="pane-sub ellipsis">{sub}</p>}
      </div>
      {children && <div className="pane-actions">{children}</div>}
    </header>
  );
}

/**
 * 下から出るシート（広い画面では右上に出るパネル）。<dialog> の showModal を使うので、
 * フォーカスの閉じ込め・Esc で閉じる・背景の操作を止める、はブラウザに任せる。背景を押しても閉じる。
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet-inner">
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="閉じる">
            <X size={20} aria-hidden />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </dialog>
  );
}

/**
 * 画面の高さを、見えている範囲（visualViewport）に合わせる。
 * iOS Safari はキーボードが出ても 100dvh が縮まないので、入力欄がキーボードに隠れないように --app-h を更新する。
 * ピンチで拡大しているときは見えている範囲が狭くなるだけなので、高さは変えない。
 */
export function useVisualViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const set = () => {
      if (vv.scale > 1.01) return;
      root.style.setProperty('--app-h', `${String(Math.round(vv.height))}px`);
    };
    set();
    vv.addEventListener('resize', set);
    return () => {
      vv.removeEventListener('resize', set);
      root.style.removeProperty('--app-h');
    };
  }, []);
}

export function Toast({ children }: { children: ReactNode }) {
  return (
    <div className="toast" role="status">
      {children}
    </div>
  );
}

/** スマホとして扱う幅。styles.css の @media (max-width: 720px) と同じ */
export const PHONE = '(max-width: 720px)';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(query);
      mq.addEventListener('change', onChange);
      return () => {
        mq.removeEventListener('change', onChange);
      };
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
