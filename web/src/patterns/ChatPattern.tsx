import { MessageSquare, SquarePen } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { Badge } from '@/components/ui/badge-clean';
import { Button } from '@/components/ui/button-clean';
import { ThinkingLoader } from '@/components/ui/thinking-loader-clean';
import type { InboxEvent } from '../api/schema';
import {
  AgentAvatar,
  Composer,
  Empty,
  HighBadge,
  ListSkeleton,
  PaneHeader,
  PHONE,
  SourceAvatar,
  StatusBadge,
  UnreadCount,
  useMediaQuery,
  usePageVisible,
} from '../ui/components';
import {
  buildSessions,
  clock,
  dayLabel,
  detailOf,
  firstLine,
  indexByRun,
  relativeTime,
  sessionIdOf,
  SOURCE_LABEL,
  summarize,
  totalUnread,
  unreadIds,
  type Session,
  type TimelineItem,
} from '../ui/derive';
import { markRead, useRead } from '../ui/readState';
import type { Navigation } from '../ui/route';
import { useNow, type AgentData } from '../ui/useAgentData';

/**
 * 会話。session を 1 つのスレッドとして見せる。
 * 開いている会話は URL で持つ（#/chat/<sessionId>）。スマホでは一覧と会話を切り替え、端末の「戻る」で一覧に戻れる。
 * 新しい会話の最初のメッセージは、エージェントが返事をするまで session がわからないので、
 * 「新しい会話」（#/chat/e:<eventId>）として仮に並べ、返事が来たら本当の session として見せる。
 */
type Selection = { kind: 'session'; id: string } | { kind: 'draft'; eventId?: string };

const NEW = 'new';
const DRAFT_PREFIX = 'e:';

function selectionOf(sub: string | undefined): Selection | undefined {
  if (!sub) return undefined;
  if (sub === NEW) return { kind: 'draft' };
  if (sub.startsWith(DRAFT_PREFIX)) return { kind: 'draft', eventId: sub.slice(DRAFT_PREFIX.length) };
  return { kind: 'session', id: sub };
}

export function ChatPattern({
  userId,
  data,
  sub,
  nav,
}: {
  userId: string;
  data: AgentData;
  sub?: string;
  nav: Navigation;
}) {
  const now = useNow();
  const sessions = useMemo(() => buildSessions(data.events, data.messages), [data.events, data.messages]);
  const drafts = useMemo(() => {
    const byRun = indexByRun(data.messages);
    return data.events.filter((e) => e.type === 'user_message' && !sessionIdOf(e, byRun));
  }, [data.events, data.messages]);

  // 仮の会話（draft）に返事が来たら、本当の session として扱う。URL で指定がなければ一番新しい会話を開く（広い画面のとき）
  const current: Selection = useMemo(() => {
    const sel = selectionOf(sub);
    if (sel?.kind === 'draft' && sel.eventId) {
      const id = sel.eventId;
      const s = sessions.find((x) => x.items.some((i) => i.kind === 'event' && i.event.eventId === id));
      if (s) return { kind: 'session', id: s.sessionId };
    }
    return sel ?? (sessions[0] ? { kind: 'session', id: sessions[0].sessionId } : { kind: 'draft' });
  }, [sub, sessions]);

  const session = current.kind === 'session' ? sessions.find((s) => s.sessionId === current.id) : undefined;
  const draftEvent = current.kind === 'draft' ? drafts.find((e) => e.eventId === current.eventId) : undefined;
  const missing = current.kind === 'session' && !session && data.loaded;

  // 既読にするのは、会話が実際に画面に出ているときだけ。
  // スマホで一覧を見ているとき（会話は隠れている）や、ブラウザのタブが裏にあるときは既読にしない
  const read = useRead();
  const phone = useMediaQuery(PHONE);
  const pageVisible = usePageVisible();
  const shown = session && pageVisible && (!phone || sub !== undefined) ? session : undefined;
  useEffect(() => {
    if (shown) markRead(unreadIds(shown, read));
  }, [shown, read]);
  const unread = totalUnread(sessions, read);

  const open = (next: string) => {
    nav.open({ sub: next });
  };

  return (
    <div className="chat split">
      <aside className="chat-list split-list" aria-label="会話">
        <div className="chat-list-head">
          <h2 className="chat-list-title-head">
            会話
            {unread > 0 && <UnreadCount n={unread} />}
          </h2>
          <Button
            size="sm"
            icon={<SquarePen size={14} strokeWidth={1.9} />}
            onClick={() => {
              open(NEW);
            }}
          >
            新しい会話
          </Button>
        </div>
        {!data.loaded && <ListSkeleton label="会話を読み込み中" />}
        <ul>
          {drafts.map((e) => (
            <li key={e.eventId}>
              <button
                type="button"
                className={`chat-list-item ${current.kind === 'draft' && current.eventId === e.eventId ? 'active' : ''}`}
                onClick={() => {
                  open(DRAFT_PREFIX + e.eventId);
                }}
              >
                <span className="chat-list-title">
                  <span className="ellipsis">{summarize(e)}</span>
                  <span className="chat-list-time">{relativeTime(e.receivedAt, now)}</span>
                </span>
                <span className="chat-list-preview">
                  <span className="ellipsis">新しい会話</span>
                  <StatusBadge status={e.status} />
                </span>
              </button>
            </li>
          ))}
          {sessions.map((s) => (
            <li key={s.sessionId}>
              <SessionListItem
                s={s}
                active={current.kind === 'session' && current.id === s.sessionId}
                unread={unreadIds(s, read).length}
                now={now}
                onClick={() => {
                  open(s.sessionId);
                }}
              />
            </li>
          ))}
        </ul>
        {data.loaded && sessions.length === 0 && drafts.length === 0 && (
          <Empty title="まだ会話がありません" icon={<MessageSquare size={18} strokeWidth={1.9} />}>
            エージェントへの最初のお願いを送ってください。
          </Empty>
        )}
      </aside>

      <section className="chat-thread split-detail" aria-label="スレッド">
        <PaneHeader
          title={session ? session.title : draftEvent ? summarize(draftEvent) : missing ? '会話' : '新しい会話'}
          sub={session ? `最終更新 ${relativeTime(session.lastAt, now)}` : undefined}
          onBack={() => {
            nav.backToList();
          }}
          backLabel="会話の一覧に戻る"
        />
        {/* キーボードでもスクロールできるように、フォーカスを受ける */}
        <div className="chat-scroll" tabIndex={0} role="region" aria-label="メッセージ">
          {session && <Thread items={session.items} busy={session.busy} />}
          {draftEvent && (
            <Thread
              items={[{ kind: 'event', at: draftEvent.receivedAt, event: draftEvent }]}
              busy={draftEvent.status === 'pending' || draftEvent.status === 'processing'}
            />
          )}
          {missing && <Empty title="この会話は見つかりません" />}
          {!session && !draftEvent && !missing && (
            <Empty title="エージェントに話しかける" icon={<MessageSquare size={18} strokeWidth={1.9} />}>
              お願いしたいこと、知らせてほしい条件、覚えておいてほしいことを書いてください。例: 「dmp-procurement
              リポジトリの通知だけ知らせてください」
            </Empty>
          )}
        </div>
        {!missing && (
          <Composer
            key={session?.sessionId ?? 'draft'}
            userId={userId}
            sessionId={session?.sessionId}
            placeholder={session ? 'この会話に返信する' : '新しい会話を始める'}
            onSent={(res) => {
              if (!session) nav.replace({ sub: DRAFT_PREFIX + res.eventId });
              data.refresh();
            }}
          />
        )}
      </section>
    </div>
  );
}

function SessionListItem({
  s,
  active,
  unread,
  now,
  onClick,
}: {
  s: Session;
  active: boolean;
  unread: number;
  now: number;
  onClick: () => void;
}) {
  const last = s.items.at(-1);
  const preview =
    last?.kind === 'message'
      ? `エージェント: ${firstLine(last.message.text, 40)}`
      : last
        ? `${SOURCE_LABEL[last.event.source] ?? last.event.source}: ${summarize(last.event)}`
        : '';
  return (
    <button
      type="button"
      className={`chat-list-item ${active ? 'active' : ''} ${unread > 0 ? 'unread' : ''}`}
      onClick={onClick}
    >
      <span className="chat-list-title">
        <span className="ellipsis">{s.title}</span>
        <span className="chat-list-time">{relativeTime(s.lastAt, now)}</span>
      </span>
      <span className="chat-list-preview">
        <span className="ellipsis">{preview}</span>
        {/* 色の付いたバッジは 1 行に 1 つ。いま動いている → 失敗 → 重要 の順に出す */}
        {s.busy ? (
          <StatusBadge status="processing" />
        ) : s.failed > 0 ? (
          <Badge tone="danger">失敗 {s.failed}</Badge>
        ) : s.hasHigh ? (
          <HighBadge />
        ) : null}
        {unread > 0 && <UnreadCount n={unread} />}
      </span>
    </button>
  );
}

/** 待っているあいだの表示。実際の状態（受付済みで順番待ち / エージェントが処理中）だけを言う */
const WAIT_PHASES = ['受付済み・順番を待っています', 'エージェントが作業中'];

function Thread({ items, busy }: { items: TimelineItem[]; busy: boolean }) {
  const processing = items.some((i) => i.kind === 'event' && i.event.status === 'processing');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [items.length, busy]);

  return (
    <div className="thread">
      {items.map((it, i) => {
        const day = dayLabel(it.at);
        const prev = i > 0 ? items.at(i - 1) : undefined;
        const divider = !prev || dayLabel(prev.at) !== day ? <div className="day-divider">{day}</div> : null;
        const key = it.kind === 'event' ? it.event.eventId : it.message.messageId;
        return (
          <div key={key}>
            {divider}
            {it.kind === 'message' ? (
              <div className={`bubble-row agent ${it.message.importance === 'high' ? 'high' : ''}`}>
                <AgentAvatar />
                <div className="bubble">
                  {it.message.importance === 'high' && <HighBadge />}
                  <p className="bubble-text">{it.message.text}</p>
                  <span className="bubble-time">{clock(it.at)}</span>
                </div>
              </div>
            ) : it.event.type === 'user_message' ? (
              <UserBubble e={it.event} />
            ) : (
              <EventCard e={it.event} />
            )}
          </div>
        );
      })}
      {busy && (
        <div className="bubble-row agent">
          <AgentAvatar />
          <ThinkingLoader phases={WAIT_PHASES} phase={processing ? 1 : 0} size="sm" />
        </div>
      )}
      <div ref={end} />
    </div>
  );
}

/** 自分のメッセージ。時刻と状態は吹き出しの外に出す（濃い吹き出しの上だとバッジが読めない） */
function UserBubble({ e }: { e: InboxEvent }) {
  return (
    <div className="bubble-row user">
      <div className="bubble-stack">
        <div className="bubble">
          <p className="bubble-text">{detailOf(e)}</p>
        </div>
        <span className="bubble-meta">
          {e.status !== 'done' && <StatusBadge status={e.status} />}
          {clock(e.receivedAt)}
        </span>
        {e.status === 'failed' && e.lastError && <span className="bubble-error">{e.lastError}</span>}
      </div>
    </div>
  );
}

function EventCard({ e }: { e: InboxEvent }) {
  const detail = detailOf(e);
  return (
    <div className="event-card">
      <SourceAvatar source={e.source} />
      <div>
        <span className="event-card-title">
          {SOURCE_LABEL[e.source] ?? e.source}: {summarize(e)}
        </span>
        {detail && <span className="event-card-detail">{detail}</span>}
      </div>
      <span className="event-card-meta">
        {clock(e.receivedAt)} <StatusBadge status={e.status} />
      </span>
    </div>
  );
}
