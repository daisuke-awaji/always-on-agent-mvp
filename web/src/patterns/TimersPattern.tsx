import { AlarmClock, Plus, Repeat } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge-clean';
import { Button } from '@/components/ui/button-clean';
import { AlertDialog } from '@/components/ui/dialog-clean';
import { ApiError, cancelTimer, createTimer, updateTimer } from '../api/client';
import type { CreateTimerBody, Timer } from '../api/schema';
import { Empty, ListSkeleton, PaneHeader } from '../ui/components';
import { relativeTime } from '../ui/derive';
import type { Navigation } from '../ui/route';
import { toHash } from '../ui/route';
import { dueLabel, KIND_LABEL, recurrenceLabel, sortTimers, TIMEZONE, untilLabel } from '../ui/timers';
import { useNow } from '../ui/useAgentData';
import type { Resource } from '../ui/useResource';
import { TimerForm } from './TimerForm';

/**
 * タイマー。記事の 2 種類を分けて並べる:
 *   繰り返し（schedule）  決まった周期でエージェントを起こす。毎朝のチェックなど
 *   1 回だけ（follow-up）  エージェントが自分で決めた期限。「前の日の夜にもう一度知らせる」など
 * エージェントが作ったものも、あなたが作ったものも、ここで変えたり取り消したりできる。
 * 開いているタイマーは URL で持つ（#/timers/<timerId>、新しいタイマーは #/timers/new）。
 */
const NEW = 'new';

export function TimersPattern({
  userId,
  timers,
  sub,
  nav,
  onToast,
}: {
  userId: string;
  timers: Resource<Timer[]>;
  sub?: string;
  nav: Navigation;
  onToast: (msg: string) => void;
}) {
  const now = useNow();
  const all = useMemo(() => sortTimers(timers.data ?? []), [timers.data]);
  const schedules = all.filter((t) => t.status === 'active' && t.kind === 'schedule');
  const followups = all.filter((t) => t.status === 'active' && t.kind === 'followup');
  const ended = all.filter((t) => t.status !== 'active');
  const selected = sub && sub !== NEW ? all.find((t) => t.timerId === sub) : undefined;

  const open = (id: string) => {
    nav.open({ view: 'timers', sub: id });
  };

  return (
    <div className="chat split">
      <aside className="chat-list split-list" aria-label="タイマーの一覧">
        <div className="chat-list-head">
          <h2 className="chat-list-title-head">タイマー</h2>
          <Button
            size="sm"
            icon={<Plus size={14} strokeWidth={1.9} />}
            onClick={() => {
              open(NEW);
            }}
          >
            新しいタイマー
          </Button>
        </div>
        {!timers.loaded && <ListSkeleton label="タイマーを読み込み中" />}
        <TimerSection title="繰り返し" items={schedules} active={sub} now={now} onOpen={open} />
        <TimerSection title="1 回だけ" items={followups} active={sub} now={now} onOpen={open} />
        <TimerSection title="終わったもの" items={ended} active={sub} now={now} onOpen={open} />
        {timers.loaded && all.length === 0 && (
          <Empty title="まだタイマーがありません" icon={<AlarmClock size={18} strokeWidth={1.9} />}>
            「明日の朝に思い出させて」と頼むと、エージェントがタイマーを作ります。ここから自分で作ることもできます。
          </Empty>
        )}
      </aside>

      <section className="chat-thread split-detail" aria-label="タイマー">
        {sub === NEW ? (
          <NewTimer
            userId={userId}
            onBack={nav.backToList}
            onCreated={(t) => {
              timers.refresh();
              onToast(`「${t.title}」を作りました（${dueLabel(t.dueAt)} に動きます）`);
              nav.replace({ view: 'timers', sub: t.timerId });
            }}
          />
        ) : selected ? (
          <TimerDetail
            key={selected.timerId}
            userId={userId}
            timer={selected}
            now={now}
            nav={nav}
            onChanged={(msg) => {
              timers.refresh();
              onToast(msg);
            }}
          />
        ) : (
          <>
            <PaneHeader
              title={sub ? 'タイマー' : 'タイマーのしくみ'}
              onBack={nav.backToList}
              backLabel="タイマーの一覧に戻る"
            />
            <div className="pane-scroll">
              {sub && timers.loaded ? <Empty title="このタイマーは見つかりません" /> : <TimersIntro />}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function TimerSection({
  title,
  items,
  active,
  now,
  onOpen,
}: {
  title: string;
  items: Timer[];
  active?: string;
  now: number;
  onOpen: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="list-section" aria-label={title}>
      <h3 className="list-section-title">
        {title} <span className="list-section-count">{items.length}</span>
      </h3>
      <ul>
        {items.map((t) => (
          <li key={t.timerId}>
            <button
              type="button"
              className={`chat-list-item ${active === t.timerId ? 'active' : ''} ${t.status !== 'active' ? 'ended' : ''}`}
              onClick={() => {
                onOpen(t.timerId);
              }}
            >
              <span className="chat-list-title">
                <span className="ellipsis">{t.title}</span>
                <span className="chat-list-time">
                  {t.status === 'active' ? untilLabel(t.dueAt, now) : relativeTime(t.updatedAt, now)}
                </span>
              </span>
              <span className="chat-list-preview">
                <span className="ellipsis">
                  {t.status === 'active'
                    ? t.recurrence
                      ? recurrenceLabel(t.recurrence)
                      : dueLabel(t.dueAt, new Date(now))
                    : t.status === 'done'
                      ? `${dueLabel(t.lastFiredAt ?? t.dueAt, new Date(now))} に動いた`
                      : '取り消した'}
                </span>
                <CreatorBadge timer={t} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 誰が作ったか。エージェントが自分で作ったものに印を付ける（色は付けない） */
function CreatorBadge({ timer }: { timer: Timer }) {
  return <Badge tone="neutral">{timer.createdBy === 'agent' ? 'エージェント' : 'あなた'}</Badge>;
}

function StatusBadgeOf({ timer }: { timer: Timer }) {
  // affectUI の info と success は文字のコントラストが足りない（axe）ので灰色にし、動いているものだけ点を付ける
  if (timer.status === 'done') return <Badge tone="neutral">終わった</Badge>;
  if (timer.status === 'cancelled') return <Badge tone="neutral">取り消した</Badge>;
  return (
    <Badge tone="neutral" dot>
      動いている
    </Badge>
  );
}

function TimersIntro() {
  return (
    <div className="pane-body intro">
      <p>
        タイマーは、決めた時刻にエージェントを起こします。時刻が来ると、スケジューラが inbox
        にイベントを入れ、エージェントがいつもの run を始めます。
      </p>
      <div className="intro-cards">
        <div className="intro-card">
          <Repeat size={18} strokeWidth={1.9} aria-hidden />
          <h3>繰り返し</h3>
          <p>
            毎朝のチェックや週末のまとめなど、決まった周期で起こします。毎回、新しい会話として起き、知らせることがなければ黙っています。
          </p>
        </div>
        <div className="intro-card">
          <AlarmClock size={18} strokeWidth={1.9} aria-hidden />
          <h3>1 回だけ</h3>
          <p>
            エージェントが自分で決めた期限です。「前の日の夜にもう一度知らせる」など。時刻が来ると、作った会話の続きとして起き、動いたら終わります。
          </p>
        </div>
      </div>
      <p className="muted">左の一覧から選ぶと、次に動く時刻を変えたり、取り消したりできます。</p>
    </div>
  );
}

function NewTimer({
  userId,
  onBack,
  onCreated,
}: {
  userId: string;
  onBack: () => void;
  onCreated: (t: Timer) => void;
}) {
  return (
    <>
      <PaneHeader title="新しいタイマー" onBack={onBack} backLabel="タイマーの一覧に戻る" />
      <div className="pane-scroll">
        <div className="pane-body">
          <TimerForm
            submitLabel="作る"
            onCancel={onBack}
            onSubmit={async (body) => {
              onCreated(await createTimer(userId, body as CreateTimerBody));
            }}
          />
        </div>
      </div>
    </>
  );
}

function TimerDetail({
  userId,
  timer: t,
  now,
  nav,
  onChanged,
}: {
  userId: string;
  timer: Timer;
  now: number;
  nav: Navigation;
  onChanged: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();
  const active = t.status === 'active';

  return (
    <>
      <PaneHeader
        title={t.title}
        sub={`${KIND_LABEL[t.kind]} · ${t.createdBy === 'agent' ? 'エージェントが作成' : 'あなたが作成'}`}
        onBack={nav.backToList}
        backLabel="タイマーの一覧に戻る"
      >
        {active && !editing && (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setEditing(true);
              }}
            >
              変更
            </Button>
            <AlertDialog
              title={`「${t.title}」を取り消しますか？`}
              description={
                t.kind === 'schedule'
                  ? 'エージェントは、この繰り返しでは起きなくなります。取り消したタイマーは戻せません（作り直せます）。'
                  : 'エージェントは、この時刻に起きなくなります。取り消したタイマーは戻せません（作り直せます）。'
              }
              confirmLabel="取り消す"
              cancelLabel="やめる"
              danger
              onConfirm={async () => {
                setError(undefined);
                try {
                  await cancelTimer(userId, t.timerId);
                  onChanged(`「${t.title}」を取り消しました`);
                } catch (err) {
                  setError(err instanceof ApiError ? `取り消せませんでした: ${err.message}` : '取り消せませんでした');
                }
              }}
              trigger={
                <Button variant="destructive" size="sm">
                  取り消す
                </Button>
              }
            />
          </>
        )}
      </PaneHeader>
      <div className="pane-scroll">
        <div className="pane-body">
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {editing ? (
            <TimerForm
              initial={t}
              submitLabel="保存"
              onCancel={() => {
                setEditing(false);
              }}
              onSubmit={async (body) => {
                const next = await updateTimer(userId, t.timerId, body);
                setEditing(false);
                onChanged(`「${next.title}」を変えました（次は ${dueLabel(next.dueAt)}）`);
              }}
            />
          ) : (
            <>
              <div className={`next-card ${active ? '' : 'ended'}`}>
                <StatusBadgeOf timer={t} />
                {active ? (
                  <>
                    <p className="next-when">{dueLabel(t.dueAt, new Date(now))}</p>
                    <p className="muted">
                      {untilLabel(t.dueAt, now)}
                      {t.kind === 'followup' ? '。動いたら終わります' : '。そのあとは次の回に進みます'}
                    </p>
                  </>
                ) : (
                  <p className="muted">
                    {t.status === 'done'
                      ? `${dueLabel(t.lastFiredAt ?? t.dueAt, new Date(now))} に動きました`
                      : `${dueLabel(t.updatedAt, new Date(now))} に取り消しました`}
                  </p>
                )}
              </div>
              <dl className="facts">
                <Fact label="繰り返し">{t.recurrence ? recurrenceLabel(t.recurrence) : '1 回だけ'}</Fact>
                <Fact label="エージェントへのメモ">{t.note ?? <span className="muted">なし</span>}</Fact>
                <Fact label="起きたとき">
                  {t.kind === 'followup' && t.sessionId ? (
                    <>
                      作った会話の続きとして起きる。{' '}
                      <a
                        href={toHash({ sub: t.sessionId })}
                        onClick={(e) => {
                          e.preventDefault();
                          nav.open({ sub: t.sessionId });
                        }}
                      >
                        会話を開く
                      </a>
                    </>
                  ) : (
                    '毎回、新しい会話として起きる'
                  )}
                </Fact>
                {t.lastFiredAt && <Fact label="最後に動いた">{dueLabel(t.lastFiredAt, new Date(now))}</Fact>}
                <Fact label="作った">
                  {dueLabel(t.createdAt, new Date(now))}（{t.createdBy === 'agent' ? 'エージェント' : 'あなた'}）
                </Fact>
                <Fact label="EventBridge Scheduler">
                  <code className="mono">{t.expression}</code> <span className="muted">{TIMEZONE}</span>
                </Fact>
              </dl>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
