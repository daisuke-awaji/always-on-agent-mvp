import { useEffect, useMemo, useRef, useState } from 'react';
import type { InboxEvent } from '../api/schema';
import { AgentAvatar, Composer, Empty, SourceAvatar, StatusBadge } from '../ui/components';
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
  type Session,
  type TimelineItem,
} from '../ui/derive';
import { useNow, type AgentData } from '../ui/useAgentData';

/**
 * パターン A: 会話。session を 1 つのスレッドとして見せる。
 * 新しい会話の最初のメッセージは、エージェントが返事をするまで session がわからないので、
 * 「新しい会話」として仮に並べ、返事が来たら本当の session に移す。
 */
type Selection = { kind: 'session'; id: string } | { kind: 'draft'; eventId?: string };

export function ChatPattern({ userId, data }: { userId: string; data: AgentData }) {
  const now = useNow();
  const sessions = useMemo(() => buildSessions(data.events, data.messages), [data.events, data.messages]);
  const drafts = useMemo(() => {
    const byRun = indexByRun(data.messages);
    return data.events.filter((e) => e.type === 'user_message' && !sessionIdOf(e, byRun));
  }, [data.events, data.messages]);
  const [sel, setSel] = useState<Selection | undefined>();
  const [showListOnMobile, setShowListOnMobile] = useState(true);

  // 仮の会話（draft）に返事が来たら、本当の session として扱う。最初は一番新しい会話を開く
  const current: Selection = useMemo(() => {
    if (sel?.kind === 'draft' && sel.eventId) {
      const id = sel.eventId;
      const s = sessions.find((x) => x.items.some((i) => i.kind === 'event' && i.event.eventId === id));
      if (s) return { kind: 'session', id: s.sessionId };
    }
    return sel ?? (sessions[0] ? { kind: 'session', id: sessions[0].sessionId } : { kind: 'draft' });
  }, [sel, sessions]);

  const session = current.kind === 'session' ? sessions.find((s) => s.sessionId === current.id) : undefined;
  const draftEvent = current.kind === 'draft' ? drafts.find((e) => e.eventId === current.eventId) : undefined;

  const open = (s: Selection) => {
    setSel(s);
    setShowListOnMobile(false);
  };

  return (
    <div className={`chat ${showListOnMobile ? 'chat-show-list' : 'chat-show-thread'}`}>
      <aside className="chat-list" aria-label="会話">
        <div className="chat-list-head">
          <h2>会話</h2>
          <button
            type="button"
            className="btn btn-primary btn-small"
            onClick={() => {
              open({ kind: 'draft' });
            }}
          >
            ＋ 新しい会話
          </button>
        </div>
        {!data.loaded && <p className="muted pad">読み込み中…</p>}
        <ul>
          {drafts.map((e) => (
            <li key={e.eventId}>
              <button
                type="button"
                className={`chat-list-item ${current.kind === 'draft' && current.eventId === e.eventId ? 'active' : ''}`}
                onClick={() => {
                  open({ kind: 'draft', eventId: e.eventId });
                }}
              >
                <span className="chat-list-title">
                  <span className="ellipsis">{summarize(e)}</span>
                </span>
                <span className="chat-list-meta">
                  <StatusBadge status={e.status} />
                  <span>{relativeTime(e.receivedAt, now)}</span>
                </span>
              </button>
            </li>
          ))}
          {sessions.map((s) => (
            <li key={s.sessionId}>
              <SessionListItem
                s={s}
                active={current.kind === 'session' && current.id === s.sessionId}
                now={now}
                onClick={() => {
                  open({ kind: 'session', id: s.sessionId });
                }}
              />
            </li>
          ))}
        </ul>
        {data.loaded && sessions.length === 0 && drafts.length === 0 && (
          <Empty title="まだ会話がありません">右の入力欄から、エージェントへの最初のお願いを送ってください。</Empty>
        )}
      </aside>

      <section className="chat-thread" aria-label="スレッド">
        <div className="chat-thread-head">
          <button
            type="button"
            className="btn btn-small chat-back"
            onClick={() => {
              setShowListOnMobile(true);
            }}
          >
            ← 会話
          </button>
          <div>
            <h2 title={session?.sessionId}>
              {session ? session.title : draftEvent ? summarize(draftEvent) : '新しい会話'}
            </h2>
            {session && <p className="muted small">最終更新 {relativeTime(session.lastAt, now)}</p>}
          </div>
        </div>
        <div className="chat-scroll">
          {session && <Thread items={session.items} busy={session.busy} />}
          {draftEvent && (
            <Thread
              items={[{ kind: 'event', at: draftEvent.receivedAt, event: draftEvent }]}
              busy={draftEvent.status === 'pending' || draftEvent.status === 'processing'}
            />
          )}
          {!session && !draftEvent && (
            <Empty title="エージェントに話しかける">
              <p>お願いしたいこと、知らせてほしい条件、覚えておいてほしいことを書いてください。</p>
              <p className="muted">例: 「dmp-procurement リポジトリの通知だけ知らせてください」</p>
            </Empty>
          )}
        </div>
        <Composer
          key={session?.sessionId ?? 'draft'}
          userId={userId}
          sessionId={session?.sessionId}
          placeholder={session ? 'この会話に返信する' : '新しい会話を始める'}
          onSent={(res) => {
            if (!session) setSel({ kind: 'draft', eventId: res.eventId });
            data.refresh();
          }}
        />
      </section>
    </div>
  );
}

function SessionListItem({
  s,
  active,
  now,
  onClick,
}: {
  s: Session;
  active: boolean;
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
    <button type="button" className={`chat-list-item ${active ? 'active' : ''}`} onClick={onClick}>
      <span className="chat-list-title">
        {s.hasHigh && <span className="dot dot-high" title="重要な連絡あり" aria-label="重要な連絡あり" />}
        <span className="ellipsis">{s.title}</span>
      </span>
      <span className="chat-list-preview">{preview}</span>
      <span className="chat-list-meta">
        {s.busy && <StatusBadge status="processing" />}
        {s.failed > 0 && <span className="badge badge-failed">失敗 {s.failed}</span>}
        <span>{relativeTime(s.lastAt, now)}</span>
      </span>
    </button>
  );
}

function Thread({ items, busy }: { items: TimelineItem[]; busy: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [items.length, busy]);

  return (
    <div className="thread">
      {items.map((it, i) => {
        const day = dayLabel(it.at);
        const prev = items[i - 1];
        const divider = !prev || dayLabel(prev.at) !== day ? <div className="day-divider">{day}</div> : null;
        const key = it.kind === 'event' ? it.event.eventId : it.message.messageId;
        return (
          <div key={key}>
            {divider}
            {it.kind === 'message' ? (
              <div className={`bubble-row agent ${it.message.importance === 'high' ? 'high' : ''}`}>
                <AgentAvatar />
                <div className="bubble">
                  {it.message.importance === 'high' && <span className="badge badge-high">重要</span>}
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
          <div className="bubble typing" aria-label="エージェントが作業中">
            <span />
            <span />
            <span />
          </div>
        </div>
      )}
      <div ref={end} />
    </div>
  );
}

function UserBubble({ e }: { e: InboxEvent }) {
  return (
    <div className="bubble-row user">
      <div className="bubble">
        <p className="bubble-text">{detailOf(e)}</p>
        <span className="bubble-time">
          {clock(e.receivedAt)} · <StatusBadge status={e.status} />
          {e.status === 'failed' && <span className="bubble-error">{e.lastError}</span>}
        </span>
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
