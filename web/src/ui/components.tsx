import { ArrowUp, ChevronLeft, FileSearch } from 'lucide-react';
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
import { Avatar } from '@/components/ui/avatar-clean';
import { Badge, type BadgeTone } from '@/components/ui/badge-clean';
import { Button } from '@/components/ui/button-clean';
import { EmptyState } from '@/components/ui/empty-state-clean';
import { IconButton } from '@/components/ui/icon-button-clean';
import { Loading, Skeleton } from '@/components/ui/skeleton-clean';
import { Spinner } from '@/components/ui/spinner-clean';
import { Tooltip } from '@/components/ui/tooltip-clean';
import { ApiError, postEvent } from '../api/client';
import type { EventStatus, PostEventBody, PostEventResponse } from '../api/schema';
import { OUTCOME_LABEL, SOURCE_LABEL, STATUS_LABEL, type RunOutcome } from './derive';

/** 状態の色は 1 か所で決める。動いているもの（処理中・実行中）だけ点が脈打つ */
const STATUS_TONE: Record<EventStatus, { tone: BadgeTone; live?: boolean }> = {
  pending: { tone: 'neutral' },
  processing: { tone: 'info', live: true },
  done: { tone: 'success' },
  failed: { tone: 'danger' },
};

const OUTCOME_TONE: Record<RunOutcome, { tone: BadgeTone; live?: boolean; dot?: boolean }> = {
  queued: { tone: 'neutral' },
  running: { tone: 'info', live: true },
  retrying: { tone: 'warning', dot: true },
  sent: { tone: 'success' },
  silent: { tone: 'neutral' },
  failed: { tone: 'danger' },
};

export function StatusBadge({ status }: { status: EventStatus }) {
  return <Badge {...STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

export function OutcomeBadge({ outcome }: { outcome: RunOutcome }) {
  return <Badge {...OUTCOME_TONE[outcome]}>{OUTCOME_LABEL[outcome]}</Badge>;
}

/** 重要な連絡の印。色の付いたバッジは 1 行に 1 つまで */
export function HighBadge() {
  return <Badge tone="warning">重要</Badge>;
}

/** イベントの送り元。人（あなた）は丸、サービスは角丸の四角 */
export function SourceAvatar({ source, size = 24 }: { source: string; size?: 20 | 24 | 32 }) {
  const label = SOURCE_LABEL[source] ?? source;
  return (
    <Avatar name={label} seed={source} size={size} shape={source === 'user' ? 'circle' : 'square'} title={label} />
  );
}

/** エージェントの印。作業中はマスがきらめく */
export function AgentAvatar({ working = false, size = 32 }: { working?: boolean; size?: 24 | 32 }) {
  return <Avatar kind="agent" seed="always-on-agent" name="エージェント" size={size} working={working} />;
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return <EmptyState bare title={title} text={children} icon={icon ?? <FileSearch size={18} strokeWidth={1.9} />} />;
}

/** 一覧の読み込み中。行と同じ形の灰色で、読み込みが終わっても位置がずれない */
export function ListSkeleton({ label }: { label: string }) {
  return (
    <Loading label={label} className="list-skeleton">
      {[180, 140, 200, 120].map((w) => (
        <div key={w} className="list-skeleton-row">
          <Skeleton line width={w} height={10} />
          <Skeleton line width={w * 1.4} height={8} />
        </div>
      ))}
    </Loading>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <Badge tone="danger">読み込みエラー</Badge>
      <span className="error-banner-text">{message}。表示は前回の内容のままです。</span>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        もう一度読み込む
      </Button>
    </div>
  );
}

/** 送るショートカットの表記。Mac は ⌘↵、それ以外は Ctrl+Enter */
const SEND_SHORTCUT =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘↵' : 'Ctrl+Enter';

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
        <Tooltip content="送る" shortcut={SEND_SHORTCUT}>
          <IconButton
            type="submit"
            variant="primary"
            label={sending ? '送信中' : '送る'}
            title=""
            disabled={!text.trim() || sending}
            icon={sending ? <Spinner size={14} /> : <ArrowUp size={15} strokeWidth={2.25} />}
          />
        </Tooltip>
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
  // 広い画面では一覧が横に見えているので、戻るボタンは出さない
  const phone = useMediaQuery(PHONE);
  return (
    <header className="pane-head">
      {phone && onBack && (
        <IconButton
          className="pane-back"
          label={backLabel ?? '戻る'}
          title=""
          onClick={onBack}
          icon={<ChevronLeft size={20} strokeWidth={2} />}
        />
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
