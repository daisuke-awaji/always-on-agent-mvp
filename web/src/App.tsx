import { AlarmClock, Check, MessageSquare, NotebookText, Play, RotateCcw, Send, SlidersHorizontal } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { Avatar } from '@/components/ui/avatar-clean';
import { Button } from '@/components/ui/button-clean';
import { Card, CardHeader } from '@/components/ui/card-clean';
import { Dialog } from '@/components/ui/dialog-clean';
import { ApiError, postEvent } from './api/client';
import type { Timer } from './api/schema';
import { agentTouchesMemory, getState, resetState } from './mocks/db';
import { DEMO_USER, SCENARIOS, type ScenarioId } from './mocks/scenarios';
import { fireNow, resumeAll } from './mocks/simulator';
import { ChatPattern } from './patterns/ChatPattern';
import { AgentAvatar, ErrorBanner, ListSkeleton, Toast, UnreadCount, useVisualViewportHeight } from './ui/components';
import { buildSessions, totalUnread } from './ui/derive';
import { SAMPLE_EVENTS } from './ui/samples';
import { dueLabel } from './ui/timers';
import { useAgentData } from './ui/useAgentData';
import { useRead } from './ui/readState';
import { toHash, useLocation, type View } from './ui/route';
import { useTimers } from './ui/useResource';

/** VITE_API_BASE を指定したとき（実際の API につなぐとき）はモックの設定を出さない */
const USE_MOCK = !import.meta.env.VITE_API_BASE;

const APP_NAME = 'Always-on Agent';

// タイマーとメモリの画面（フォームの部品が大きい）は、開いたときに読み込む
const TimersPattern = lazy(() => import('./patterns/TimersPattern').then((m) => ({ default: m.TimersPattern })));
const MemoryPattern = lazy(() => import('./patterns/MemoryPattern').then((m) => ({ default: m.MemoryPattern })));

/** 画面。会話は view なし（#/） */
const VIEW_LABEL = { chat: '会話', timers: 'タイマー', memory: 'メモリ' } as const;
type ViewKey = keyof typeof VIEW_LABEL;
const VIEW_ICON: Record<ViewKey, ReactNode> = {
  chat: <MessageSquare size={18} strokeWidth={1.9} aria-hidden />,
  timers: <AlarmClock size={18} strokeWidth={1.9} aria-hidden />,
  memory: <NotebookText size={18} strokeWidth={1.9} aria-hidden />,
};

export function App() {
  const { loc, ...nav } = useLocation();
  const [toast, setToast] = useState<string>();
  const userId = DEMO_USER;
  const data = useAgentData(userId);
  const read = useRead();
  const sessions = useMemo(() => buildSessions(data.events, data.messages), [data.events, data.messages]);
  const unread = totalUnread(sessions, read);
  const timers = useTimers(userId);
  const activeTimers = (timers.data ?? []).filter((t) => t.status === 'active');
  const view: ViewKey = loc.view ?? 'chat';
  useVisualViewportHeight();

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => {
      setToast(undefined);
    }, 3500);
    return () => {
      clearTimeout(t);
    };
  }, [toast]);

  // ブラウザのタブ名にも未読数を出す。裏のタブにあっても、返信が来たことがわかる
  useEffect(() => {
    const name = `${VIEW_LABEL[view]} — ${APP_NAME}`;
    document.title = unread > 0 ? `(${String(unread)}) ${name}` : name;
  }, [unread, view]);

  const navItems = (Object.keys(VIEW_LABEL) as ViewKey[]).map((key) => ({
    key,
    label: VIEW_LABEL[key],
    href: toHash(key === 'chat' ? {} : { view: key }),
    badge:
      key === 'chat' && unread > 0 ? (
        <UnreadCount n={unread} />
      ) : key === 'timers' && activeTimers.length > 0 ? (
        <span className="nav-count">
          {activeTimers.length}
          <span className="sr-only"> 件動いています</span>
        </span>
      ) : null,
    onClick: (e: MouseEvent) => {
      e.preventDefault();
      nav.go(key === 'chat' ? undefined : (key satisfies View));
    },
  }));

  return (
    // has-sub: 会話を 1 つ開いている。スマホではその会話を画面いっぱいに出す（上のバーを隠す）
    <div className={`app ${loc.sub ? 'has-sub' : ''}`}>
      <header className="topbar">
        {/* 読み上げの名前は見えている文字と同じにする（スマホでは文字を隠すので aria-label で渡す） */}
        <a className="brand" href="#/" aria-label={`${APP_NAME} UI モック`}>
          <AgentAvatar size={24} />
          <span className="brand-name">{APP_NAME}</span> <span className="brand-sub">UI モック</span>
        </a>
        {/* 広い画面: 画面の切り替え。スマホでは下のタブバーにする */}
        <nav className="topnav" aria-label="画面">
          {navItems.map((n) => (
            <a key={n.key} href={n.href} aria-current={view === n.key ? 'page' : undefined} onClick={n.onClick}>
              {n.label}
              {n.badge}
            </a>
          ))}
        </nav>
        {/* スマホだけ: 画面名と未読数。広い画面では一覧の見出しに出す */}
        <span className="topbar-title" aria-hidden>
          {VIEW_LABEL[view]}
          {view === 'chat' && unread > 0 && <UnreadCount n={unread} />}
        </span>
        <div className="topbar-right">
          <span className="user-chip" title="userId">
            <Avatar name={userId} seed={userId} size={20} aria-hidden />
            <span className="user-name">{userId}</span>
          </span>
          {USE_MOCK && (
            <MockPanel
              userId={userId}
              timers={activeTimers}
              onPosted={(msg) => {
                setToast(msg);
                data.refresh();
                timers.refresh();
              }}
            />
          )}
        </div>
      </header>
      {data.error && <ErrorBanner message={data.error} onRetry={data.refresh} />}
      <main className="main">
        <h1 className="sr-only">{VIEW_LABEL[view]}</h1>
        {view === 'chat' && <ChatPattern userId={userId} data={data} sub={loc.sub} nav={nav} />}
        <Suspense fallback={<ListSkeleton label="読み込み中" />}>
          {view === 'timers' && (
            <TimersPattern userId={userId} timers={timers} sub={loc.sub} nav={nav} onToast={setToast} />
          )}
          {view === 'memory' && <MemoryPattern userId={userId} sub={loc.sub} nav={nav} onToast={setToast} />}
        </Suspense>
      </main>
      {/* スマホだけ: 下のタブバー。何かを開いているあいだは隠す（その画面を広く使う） */}
      <nav className="tabbar" aria-label="画面">
        {navItems.map((n) => (
          <a key={n.key} href={n.href} aria-current={view === n.key ? 'page' : undefined} onClick={n.onClick}>
            {VIEW_ICON[n.key]}
            <span className="tabbar-label">{n.label}</span>
            {n.badge && <span className="tabbar-badge">{n.badge}</span>}
          </a>
        ))}
      </nav>
      {toast && <Toast>{toast}</Toast>}
    </div>
  );
}

/**
 * モックの設定（シナリオの切り替え、データの初期化、Webhook の送信、タイマーをすぐ動かす、エージェントの書き込み）。
 * 実際の API につなぐときは出さない
 */
function MockPanel({ userId, timers, onPosted }: { userId: string; timers: Timer[]; onPosted: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [scenario, setScenario] = useState<ScenarioId>(() => getState().scenario);
  // 送ったり切り替えたりしたら閉じて、結果（トーストと画面の変化）が見えるようにする
  const done = (msg: string) => {
    setOpen(false);
    onPosted(msg);
  };

  const send = async (id: string) => {
    const sample = SAMPLE_EVENTS.find((s) => s.id === id);
    if (!sample) return;
    try {
      const res = await postEvent(userId, sample.body());
      done(
        res.duplicate
          ? `重複として受け付けました（duplicate: true, eventId ${res.eventId.slice(0, 8)}…）`
          : `「${sample.label}」を送りました（202）`,
      );
    } catch (err) {
      done(err instanceof ApiError ? `送信に失敗: ${err.message}` : '送信に失敗しました');
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="モック設定"
      description="ブラウザの中のモック（MSW）だけを変えます。AWS にはつながりません。"
      closeLabel="閉じる"
      trigger={
        <Button variant="secondary" size="sm" icon={<SlidersHorizontal size={14} strokeWidth={1.9} />}>
          {/* 名前は中の文字から決まる（スマホでは見た目だけ隠して、読み上げには残す） */}
          <span className="mock-label">モック設定</span>{' '}
          <span className="mock-scenario">{SCENARIOS[scenario].label}</span>
        </Button>
      }
    >
      <section className="mock-section" aria-labelledby="mock-scenario-title">
        <div className="mock-section-head">
          <h3 id="mock-scenario-title">シナリオ</h3>
          <Button
            variant="ghost"
            size="sm"
            icon={<RotateCcw size={14} strokeWidth={1.9} />}
            onClick={() => {
              resetState(scenario);
              resumeAll();
              done('データを初期状態に戻しました');
            }}
          >
            最初からやり直す
          </Button>
        </div>
        <ul className="choice-list">
          {Object.values(SCENARIOS).map((s) => (
            <Card key={s.id} as="li" interactive selected={scenario === s.id}>
              <CardHeader
                titleAs="p"
                title={
                  <button
                    type="button"
                    aria-pressed={scenario === s.id}
                    onClick={() => {
                      setScenario(s.id);
                      resetState(s.id);
                      resumeAll();
                      done(`シナリオ「${s.label}」に切り替えました`);
                    }}
                  >
                    {s.label}
                  </button>
                }
                description={s.description}
                action={scenario === s.id ? <Check size={16} strokeWidth={2} aria-hidden /> : undefined}
              />
            </Card>
          ))}
        </ul>
      </section>
      <section className="mock-section" aria-labelledby="mock-webhook-title">
        <div className="mock-section-head">
          <h3 id="mock-webhook-title">Webhook を送る</h3>
          <code className="mock-endpoint">POST /users/{userId}/events</code>
        </div>
        <ul className="choice-list">
          {SAMPLE_EVENTS.map((s) => (
            <Card key={s.id} as="li" interactive>
              <CardHeader
                titleAs="p"
                title={
                  <button type="button" onClick={() => void send(s.id)}>
                    {s.label}
                  </button>
                }
                description={s.hint}
                action={<Send size={14} strokeWidth={1.9} aria-hidden />}
              />
            </Card>
          ))}
        </ul>
      </section>
      <section className="mock-section" aria-labelledby="mock-timer-title">
        <div className="mock-section-head">
          <h3 id="mock-timer-title">タイマーを今すぐ動かす</h3>
          <code className="mock-endpoint">scheduler → inbox</code>
        </div>
        {timers.length === 0 && <p className="mock-note">動いているタイマーはありません。</p>}
        <ul className="choice-list">
          {timers.map((t) => (
            <Card key={t.timerId} as="li" interactive>
              <CardHeader
                titleAs="p"
                title={
                  <button
                    type="button"
                    onClick={() => {
                      done(
                        fireNow(t.timerId)
                          ? `「${t.title}」を動かしました（system イベントを inbox に入れました）`
                          : 'このタイマーはもう動いていません',
                      );
                    }}
                  >
                    {t.title}
                  </button>
                }
                description={`予定: ${dueLabel(t.dueAt)}${t.kind === 'schedule' ? '（繰り返しの次の回はずらさない）' : '（動いたら終わり）'}`}
                action={<Play size={14} strokeWidth={1.9} aria-hidden />}
              />
            </Card>
          ))}
        </ul>
      </section>
      <section className="mock-section" aria-labelledby="mock-memory-title">
        <div className="mock-section-head">
          <h3 id="mock-memory-title">エージェントがメモリを書く</h3>
        </div>
        <ul className="choice-list">
          <Card as="li" interactive>
            <CardHeader
              titleAs="p"
              title={
                <button
                  type="button"
                  onClick={() => {
                    agentTouchesMemory(userId);
                    done('エージェントが instructions.md に 1 行足しました（編集中なら、保存の前に知らせます）');
                  }}
                >
                  instructions.md に 1 行足す
                </button>
              }
              description="画面で編集しているあいだに run が書き換えたときの表示（版の食い違い、API では 409）を確かめる"
              action={<Send size={14} strokeWidth={1.9} aria-hidden />}
            />
          </Card>
        </ul>
      </section>
    </Dialog>
  );
}
