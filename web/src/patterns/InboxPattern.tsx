import { useMemo, useState, type ReactNode } from 'react';
import type { StoredMessage } from '../api/schema';
import { Composer, Empty, SourceAvatar, StatusBadge } from '../ui/components';
import {
  buildRuns,
  buildSessions,
  clock,
  dayLabel,
  detailOf,
  firstLine,
  relativeTime,
  SOURCE_LABEL,
  summarize,
  type Run,
} from '../ui/derive';
import { useNow, type AgentData } from '../ui/useAgentData';

/**
 * パターン B: 通知箱。エージェントからの連絡を受信箱として並べる。
 * それぞれの連絡に「きっかけになったイベント」（同じ runId のイベント）を添え、
 * 知らせなかった run（静かに完了）も別にまとめて見せる。
 * 既読はこの画面だけの状態（localStorage）で、API にはない。
 */
type Filter = 'all' | 'high' | 'unread';
const READ_KEY = 'aoa-ui:read-messages';

function loadRead(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(READ_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function InboxPattern({ userId, data }: { userId: string; data: AgentData }) {
  const now = useNow();
  const [filter, setFilter] = useState<Filter>('all');
  const [read, setRead] = useState(loadRead);
  const [selectedId, setSelectedId] = useState<string>();
  const [showSilent, setShowSilent] = useState(false);
  const [showListOnMobile, setShowListOnMobile] = useState(true);

  const runs = useMemo(() => buildRuns(data.events, data.messages), [data.events, data.messages]);
  const runById = useMemo(() => new Map(runs.map((r) => [r.runId, r])), [runs]);
  const sessions = useMemo(() => buildSessions(data.events, data.messages), [data.events, data.messages]);
  const silentRuns = runs.filter((r) => r.outcome === 'silent');
  const working = runs.filter((r) => r.outcome === 'running' || r.outcome === 'queued' || r.outcome === 'retrying');
  const failedRuns = runs.filter((r) => r.outcome === 'failed');

  const markRead = (id: string) => {
    setRead((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev).add(id);
      localStorage.setItem(READ_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const list = data.messages.filter((m) =>
    filter === 'high' ? m.importance === 'high' : filter === 'unread' ? !read.has(m.messageId) : true,
  );
  const unread = data.messages.filter((m) => !read.has(m.messageId)).length;
  const selected = data.messages.find((m) => m.messageId === selectedId) ?? (selectedId ? undefined : list[0]);

  return (
    <div className={`inbox ${showListOnMobile ? 'inbox-show-list' : 'inbox-show-detail'}`}>
      <aside className="inbox-list" aria-label="連絡">
        <div className="inbox-head">
          <h2>エージェントからの連絡</h2>
          <div className="chips" role="tablist">
            {(
              [
                ['all', `すべて ${data.messages.length}`],
                ['unread', `未読 ${unread}`],
                ['high', '重要'],
              ] as const
            ).map(([f, label]) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                className={`chip ${filter === f ? 'chip-active' : ''}`}
                onClick={() => {
                  setFilter(f);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {working.length > 0 && (
          <div className="inbox-working">
            <StatusBadge status="processing" />
            <span>{working.length} 件のイベントを見ています</span>
          </div>
        )}
        {failedRuns.length > 0 && (
          <div className="inbox-failed">
            <span className="badge badge-failed">失敗</span>
            <span>処理できなかったイベントが {failedRuns.reduce((n, r) => n + r.events.length, 0)} 件あります</span>
          </div>
        )}

        {!data.loaded && <p className="muted pad">読み込み中…</p>}
        <ul className="inbox-items">
          {list.map((m, i) => {
            const day = dayLabel(m.createdAt);
            const prev = list[i - 1];
            const divider = !prev || dayLabel(prev.createdAt) !== day ? <li className="inbox-day">{day}</li> : null;
            const run = runById.get(m.runId);
            return (
              <FragmentLi key={m.messageId} divider={divider}>
                <button
                  type="button"
                  className={`inbox-item ${selected?.messageId === m.messageId ? 'active' : ''} ${read.has(m.messageId) ? 'read' : 'unread'}`}
                  onClick={() => {
                    setSelectedId(m.messageId);
                    markRead(m.messageId);
                    setShowListOnMobile(false);
                  }}
                >
                  <span
                    className={`dot ${m.importance === 'high' ? 'dot-high' : read.has(m.messageId) ? 'dot-none' : 'dot-unread'}`}
                    aria-hidden
                  />
                  <span className="inbox-item-body">
                    <span className="inbox-item-title">{firstLine(m.text, 70)}</span>
                    <span className="inbox-item-meta">
                      {triggerLabel(run)} · {relativeTime(m.createdAt, now)}
                    </span>
                  </span>
                </button>
              </FragmentLi>
            );
          })}
        </ul>
        {data.loaded && list.length === 0 && (
          <Empty title={filter === 'all' ? 'まだ連絡はありません' : '該当する連絡はありません'}>
            エージェントは、知らせる価値があると判断したときだけ連絡します。
          </Empty>
        )}

        <div className="silent-box">
          <button
            type="button"
            className="silent-toggle"
            aria-expanded={showSilent}
            onClick={() => {
              setShowSilent((v) => !v);
            }}
          >
            <span>知らせなかった通知 {silentRuns.reduce((n, r) => n + r.events.length, 0)} 件</span>
            <span className="muted">{showSilent ? '閉じる' : '見る'}</span>
          </button>
          {showSilent && (
            <ul className="silent-list">
              {silentRuns.map((r) =>
                r.events.map((e) => (
                  <li key={e.eventId}>
                    <SourceAvatar source={e.source} />
                    <span>{summarize(e)}</span>
                    <span className="muted">{relativeTime(e.receivedAt, now)}</span>
                  </li>
                )),
              )}
              {silentRuns.length === 0 && <li className="muted">ありません</li>}
            </ul>
          )}
        </div>
      </aside>

      <section className="inbox-detail" aria-label="連絡の詳細">
        <button
          type="button"
          className="btn btn-small inbox-back"
          onClick={() => {
            setShowListOnMobile(true);
          }}
        >
          ← 一覧
        </button>
        {selected ? (
          <Detail
            key={selected.messageId}
            userId={userId}
            m={selected}
            run={runById.get(selected.runId)}
            followUps={
              sessions
                .find((s) => s.sessionId === selected.sessionId)
                ?.items.filter((i) => i.at > selected.createdAt) ?? []
            }
            onSent={data.refresh}
          />
        ) : (
          <Empty title="連絡を選んでください" />
        )}
      </section>
    </div>
  );
}

function FragmentLi({ divider, children }: { divider: ReactNode; children: ReactNode }) {
  return (
    <>
      {divider}
      <li>{children}</li>
    </>
  );
}

function triggerLabel(run: Run | undefined): string {
  if (!run) return 'エージェント';
  const sources = [...new Set(run.events.map((e) => SOURCE_LABEL[e.source] ?? e.source))];
  if (sources.length === 1 && sources[0] === 'あなた') return 'あなたへの返事';
  return `${sources.join('・')} の通知から`;
}

function Detail({
  userId,
  m,
  run,
  followUps,
  onSent,
}: {
  userId: string;
  m: StoredMessage;
  run: Run | undefined;
  followUps: ReturnType<typeof buildSessions>[number]['items'];
  onSent: () => void;
}) {
  return (
    <article className="detail">
      <header className="detail-head">
        {m.importance === 'high' && <span className="badge badge-high">重要</span>}
        <span className="muted">
          {dayLabel(m.createdAt)} {clock(m.createdAt)}
        </span>
      </header>
      <p className="detail-text">{m.text}</p>

      {run && (
        <section className="detail-why">
          <h3>きっかけになった通知</h3>
          <ul>
            {run.events.map((e) => (
              <li key={e.eventId}>
                <SourceAvatar source={e.source} />
                <span className="why-main">
                  <span>{summarize(e)}</span>
                  {detailOf(e) && e.type !== 'user_message' && <span className="muted">{detailOf(e)}</span>}
                </span>
                <span className="muted">{clock(e.receivedAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {followUps.length > 0 && (
        <section className="detail-followups">
          <h3>このあとのやりとり</h3>
          <ul>
            {followUps.map((i) =>
              i.kind === 'event' ? (
                <li key={i.event.eventId} className="fu-user">
                  <span>あなた: {summarize(i.event)}</span> <StatusBadge status={i.event.status} />
                </li>
              ) : (
                <li key={i.message.messageId} className="fu-agent">
                  エージェント: {firstLine(i.message.text, 80)}
                </li>
              ),
            )}
          </ul>
        </section>
      )}

      <div className="detail-reply">
        <Composer userId={userId} sessionId={m.sessionId} placeholder="この連絡に返事をする" onSent={onSent} />
      </div>
    </article>
  );
}
