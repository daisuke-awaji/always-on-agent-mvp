import { ChevronDown, Inbox, MessageSquare } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge-clean';
import { Button } from '@/components/ui/button-clean';
import { SegmentedControl } from '@/components/ui/segmented-control-clean';
import { Spinner } from '@/components/ui/spinner-clean';
import type { StoredMessage } from '../api/schema';
import { Composer, Empty, HighBadge, ListSkeleton, PaneHeader, SourceAvatar, StatusBadge } from '../ui/components';
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
import { markRead, useRead } from '../ui/readState';
import type { Navigation } from '../ui/route';
import { useNow, type AgentData } from '../ui/useAgentData';

/**
 * パターン B: 通知箱。エージェントからの連絡を受信箱として並べる。
 * それぞれの連絡に「きっかけになったイベント」（同じ runId のイベント）を添え、
 * 知らせなかった run（静かに完了）も別にまとめて見せる。
 * 開いている連絡は URL で持つ（#/inbox/<messageId>）。既読はこの画面だけの状態（readState.ts）。
 */
type Filter = 'all' | 'high' | 'unread';

export function InboxPattern({
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
  const [filter, setFilter] = useState<Filter>('all');
  const read = useRead();
  const [showSilent, setShowSilent] = useState(false);

  const runs = useMemo(() => buildRuns(data.events, data.messages), [data.events, data.messages]);
  const runById = useMemo(() => new Map(runs.map((r) => [r.runId, r])), [runs]);
  const sessions = useMemo(() => buildSessions(data.events, data.messages), [data.events, data.messages]);
  const silentRuns = runs.filter((r) => r.outcome === 'silent');
  const working = runs.filter((r) => r.outcome === 'running' || r.outcome === 'queued' || r.outcome === 'retrying');
  const failedRuns = runs.filter((r) => r.outcome === 'failed');

  const list = data.messages.filter((m) =>
    filter === 'high' ? m.importance === 'high' : filter === 'unread' ? !read.has(m.messageId) : true,
  );
  const unread = data.messages.filter((m) => !read.has(m.messageId)).length;
  const high = data.messages.filter((m) => m.importance === 'high').length;
  // URL で指定がなければ一覧の先頭を見せる（広い画面のとき。スマホでは一覧だけを見せる）
  const selected = sub ? data.messages.find((m) => m.messageId === sub) : list[0];

  // 開いた連絡を既読にする（URL を直接開いたときも）
  const openedId = sub && selected ? selected.messageId : undefined;
  useEffect(() => {
    if (openedId) markRead(openedId);
  }, [openedId]);

  return (
    <div className="inbox split">
      <aside className="inbox-list split-list" aria-label="連絡">
        <div className="inbox-head">
          <h2>エージェントからの連絡</h2>
          <SegmentedControl<Filter>
            aria-label="絞り込み"
            variant="tray"
            size="sm"
            fullWidth
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'すべて', count: data.messages.length },
              { value: 'unread', label: '未読', count: unread },
              { value: 'high', label: '重要', count: high },
            ]}
          />
        </div>

        {working.length > 0 && (
          <div className="inbox-note">
            <Spinner size={12} />
            <span>{working.length} 件のイベントを見ています</span>
          </div>
        )}
        {failedRuns.length > 0 && (
          <div className="inbox-note">
            <Badge tone="danger">失敗</Badge>
            <span>処理できなかったイベントが {failedRuns.reduce((n, r) => n + r.events.length, 0)} 件あります</span>
          </div>
        )}

        {!data.loaded && <ListSkeleton label="連絡を読み込み中" />}
        <ul className="inbox-items">
          {list.map((m, i) => {
            const day = dayLabel(m.createdAt);
            const prev = i > 0 ? list.at(i - 1) : undefined;
            const divider = !prev || dayLabel(prev.createdAt) !== day ? <li className="inbox-day">{day}</li> : null;
            const run = runById.get(m.runId);
            const isRead = read.has(m.messageId);
            return (
              <FragmentLi key={m.messageId} divider={divider}>
                <button
                  type="button"
                  className={`inbox-item ${selected?.messageId === m.messageId ? 'active' : ''} ${isRead ? 'read' : 'unread'}`}
                  onClick={() => {
                    nav.open({ route: 'inbox', sub: m.messageId });
                  }}
                >
                  <span className="unread-mark" aria-label={isRead ? undefined : '未読'} />
                  <span className="inbox-item-body">
                    <span className="inbox-item-title">{firstLine(m.text, 120)}</span>
                    <span className="inbox-item-meta">
                      {m.importance === 'high' && <HighBadge />}
                      <span className="ellipsis">{triggerLabel(run)}</span>
                      <span className="nowrap">{relativeTime(m.createdAt, now)}</span>
                    </span>
                  </span>
                </button>
              </FragmentLi>
            );
          })}
        </ul>
        {data.loaded && list.length === 0 && (
          <Empty
            title={filter === 'all' ? 'まだ連絡はありません' : '該当する連絡はありません'}
            icon={<Inbox size={18} strokeWidth={1.9} />}
          >
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
            <ChevronDown size={18} className="chevron" aria-hidden />
          </button>
          {showSilent && (
            <ul className="silent-list">
              {silentRuns.map((r) =>
                r.events.map((e) => (
                  <li key={e.eventId}>
                    <SourceAvatar source={e.source} size={20} />
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

      <section className="inbox-detail split-detail" aria-label="連絡の詳細">
        <PaneHeader
          title={selected ? (selected.importance === 'high' ? '重要な連絡' : '連絡') : '連絡'}
          sub={selected ? `${dayLabel(selected.createdAt)} ${clock(selected.createdAt)}` : undefined}
          onBack={() => {
            nav.backToList('inbox');
          }}
          backLabel="連絡の一覧に戻る"
        >
          {selected && (
            <Button
              variant="secondary"
              size="sm"
              icon={<MessageSquare size={14} strokeWidth={1.9} />}
              onClick={() => {
                nav.open({ route: 'chat', sub: selected.sessionId });
              }}
            >
              会話で開く
            </Button>
          )}
        </PaneHeader>
        {selected ? (
          <>
            <div className="detail-scroll">
              <Detail
                key={selected.messageId}
                m={selected}
                run={runById.get(selected.runId)}
                followUps={
                  sessions
                    .find((s) => s.sessionId === selected.sessionId)
                    ?.items.filter((i) => i.at > selected.createdAt) ?? []
                }
              />
            </div>
            <Composer
              key={selected.messageId}
              userId={userId}
              sessionId={selected.sessionId}
              placeholder="この連絡に返事をする"
              onSent={data.refresh}
            />
          </>
        ) : (
          <Empty
            title={sub && data.loaded ? 'この連絡は見つかりません' : '連絡を選んでください'}
            icon={<Inbox size={18} strokeWidth={1.9} />}
          />
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
  m,
  run,
  followUps,
}: {
  m: StoredMessage;
  run: Run | undefined;
  followUps: ReturnType<typeof buildSessions>[number]['items'];
}) {
  return (
    <article className="detail">
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
    </article>
  );
}
