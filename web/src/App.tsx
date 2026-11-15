import { Check, RotateCcw, Send, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Avatar } from '@/components/ui/avatar-clean';
import { Button } from '@/components/ui/button-clean';
import { Card, CardHeader } from '@/components/ui/card-clean';
import { Dialog } from '@/components/ui/dialog-clean';
import { ApiError, postEvent } from './api/client';
import { resetState, getState } from './mocks/db';
import { DEMO_USER, SCENARIOS, type ScenarioId } from './mocks/scenarios';
import { resumeAll } from './mocks/simulator';
import { ChatPattern } from './patterns/ChatPattern';
import { AgentAvatar, ErrorBanner, Toast, UnreadCount, useVisualViewportHeight } from './ui/components';
import { buildSessions, totalUnread } from './ui/derive';
import { SAMPLE_EVENTS } from './ui/samples';
import { useAgentData } from './ui/useAgentData';
import { useRead } from './ui/readState';
import { useLocation } from './ui/route';

/** VITE_API_BASE を指定したとき（実際の API につなぐとき）はモックの設定を出さない */
const USE_MOCK = !import.meta.env.VITE_API_BASE;

const APP_NAME = 'Always-on Agent';

export function App() {
  const { loc, ...nav } = useLocation();
  const [toast, setToast] = useState<string>();
  const userId = DEMO_USER;
  const data = useAgentData(userId);
  const read = useRead();
  const sessions = useMemo(() => buildSessions(data.events, data.messages), [data.events, data.messages]);
  const unread = totalUnread(sessions, read);
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
    document.title = unread > 0 ? `(${String(unread)}) 会話 — ${APP_NAME}` : `会話 — ${APP_NAME}`;
  }, [unread]);

  return (
    // has-sub: 会話を 1 つ開いている。スマホではその会話を画面いっぱいに出す（上のバーを隠す）
    <div className={`app ${loc.sub ? 'has-sub' : ''}`}>
      <header className="topbar">
        {/* 読み上げの名前は見えている文字と同じにする（スマホでは文字を隠すので aria-label で渡す） */}
        <a className="brand" href="#/" aria-label={`${APP_NAME} UI モック`}>
          <AgentAvatar size={24} />
          <span className="brand-name">{APP_NAME}</span> <span className="brand-sub">UI モック</span>
        </a>
        {/* スマホだけ: 画面名と未読数。広い画面では会話一覧の見出しに出す */}
        <span className="topbar-title" aria-hidden>
          会話
          {unread > 0 && <UnreadCount n={unread} />}
        </span>
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
        <h1 className="sr-only">会話</h1>
        <ChatPattern userId={userId} data={data} sub={loc.sub} nav={nav} />
      </main>
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
    </Dialog>
  );
}
