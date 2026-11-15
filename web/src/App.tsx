import { Activity, Check, Inbox, LayoutGrid, MessageSquare, RotateCcw, Send, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Avatar } from '@/components/ui/avatar-clean';
import { Badge } from '@/components/ui/badge-clean';
import { Button } from '@/components/ui/button-clean';
import { Card, CardHeader } from '@/components/ui/card-clean';
import { Dialog } from '@/components/ui/dialog-clean';
import { ApiError, postEvent } from './api/client';
import { resetState, getState } from './mocks/db';
import { DEMO_USER, SCENARIOS, type ScenarioId } from './mocks/scenarios';
import { resumeAll } from './mocks/simulator';
import { ChatPattern } from './patterns/ChatPattern';
import { ConsolePattern } from './patterns/ConsolePattern';
import { InboxPattern } from './patterns/InboxPattern';
import { Overview } from './patterns/Overview';
import { AgentAvatar, ErrorBanner, Toast, useVisualViewportHeight } from './ui/components';
import { SAMPLE_EVENTS } from './ui/samples';
import { useAgentData } from './ui/useAgentData';
import { PATTERNS } from './ui/patterns';
import { useRead } from './ui/readState';
import { useLocation, type Route } from './ui/route';

/** VITE_API_BASE を指定したとき（実際の API につなぐとき）はモックの設定を出さない */
const USE_MOCK = !import.meta.env.VITE_API_BASE;

const NAV: { route: Route; label: string; Icon: typeof LayoutGrid }[] = [
  { route: 'overview', label: '概要', Icon: LayoutGrid },
  { route: 'chat', label: '会話', Icon: MessageSquare },
  { route: 'inbox', label: '通知箱', Icon: Inbox },
  { route: 'console', label: '運用', Icon: Activity },
];

export function App() {
  const { loc, ...nav } = useLocation();
  const [toast, setToast] = useState<string>();
  const userId = DEMO_USER;
  const data = useAgentData(userId);
  const read = useRead();
  const unread = data.messages.filter((m) => !read.has(m.messageId)).length;
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

  const route = loc.route;
  const title = NAV.find((n) => n.route === route)?.label ?? '';

  return (
    // has-sub: 一覧の中の 1 件を開いている。スマホではその 1 件を画面いっぱいに出す（上下のバーを隠す）
    <div className={`app route-${route} ${loc.sub ? 'has-sub' : ''}`}>
      <header className="topbar">
        <a className="brand" href="#/" aria-label="Always-on Agent UI モック（概要）">
          <AgentAvatar size={24} />
          <span className="brand-name">Always-on Agent</span>
          <span className="brand-sub">UI モック</span>
        </a>
        <span className="topbar-title" aria-hidden>
          {title}
        </span>
        <nav className="tabs" aria-label="パターン">
          {PATTERNS.map((p) => (
            <a
              key={p.route}
              href={`#/${p.route}`}
              className={`tab ${route === p.route ? 'tab-active' : ''}`}
              aria-current={route === p.route ? 'page' : undefined}
            >
              <span className="tab-letter">{p.letter}</span>
              {p.name}
              {p.route === 'inbox' && unread > 0 && <Badge count={unread} aria-label={`未読 ${String(unread)} 件`} />}
            </a>
          ))}
        </nav>
        <div className="topbar-right">
          <span className="user-chip" title="userId">
            <Avatar name={userId} seed={userId} size={20} aria-hidden />
            <span className="user-name">{userId}</span>
          </span>
          {USE_MOCK && (
            <MockPanel
              userId={userId}
              onPosted={(msg) => {
                setToast(msg);
                data.refresh();
              }}
            />
          )}
        </div>
      </header>
      {data.error && <ErrorBanner message={data.error} onRetry={data.refresh} />}
      <main className="main">
        {/* 画面の見出し。上のバーはスマホで隠すことがあるので、main の中に置く */}
        <h1 className="sr-only">{title}</h1>
        {route === 'overview' && <Overview data={data} />}
        {route === 'chat' && <ChatPattern userId={userId} data={data} sub={loc.sub} nav={nav} />}
        {route === 'inbox' && <InboxPattern userId={userId} data={data} sub={loc.sub} nav={nav} />}
        {route === 'console' && <ConsolePattern userId={userId} data={data} />}
      </main>
      {/* スマホだけ: 親指の届く下にパターンの切り替えを置く */}
      <nav className="bottom-nav" aria-label="画面">
        {NAV.map(({ route: r, label, Icon }) => (
          <a
            key={r}
            href={r === 'overview' ? '#/' : `#/${r}`}
            className={`bottom-nav-item ${route === r ? 'active' : ''}`}
            aria-current={route === r ? 'page' : undefined}
          >
            <span className="bottom-nav-icon">
              <Icon size={24} strokeWidth={route === r ? 2.25 : 1.75} aria-hidden />
              {r === 'inbox' && unread > 0 && (
                <span className="count-on-icon">
                  <Badge count={unread} aria-label={`未読 ${String(unread)} 件`} />
                </span>
              )}
            </span>
            {label}
          </a>
        ))}
      </nav>
      {toast && <Toast>{toast}</Toast>}
    </div>
  );
}

/** モックの設定（シナリオの切り替え、データの初期化、Webhook の送信）。実際の API につなぐときは出さない */
function MockPanel({ userId, onPosted }: { userId: string; onPosted: (msg: string) => void }) {
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
        <Button
          variant="secondary"
          size="sm"
          icon={<SlidersHorizontal size={14} strokeWidth={1.9} />}
          aria-label={`モック設定（${SCENARIOS[scenario].label}）`}
        >
          <span className="mock-label">モック設定</span>
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
    </Dialog>
  );
}
