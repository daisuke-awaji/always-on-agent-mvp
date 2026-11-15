import { useEffect, useState } from 'react';
import { ApiError, postEvent } from './api/client';
import { resetState, getState } from './mocks/db';
import { DEMO_USER, SCENARIOS, type ScenarioId } from './mocks/scenarios';
import { resumeAll } from './mocks/simulator';
import { ChatPattern } from './patterns/ChatPattern';
import { ConsolePattern } from './patterns/ConsolePattern';
import { InboxPattern } from './patterns/InboxPattern';
import { Overview } from './patterns/Overview';
import { ErrorBanner, Toast } from './ui/components';
import { SAMPLE_EVENTS } from './ui/samples';
import { useAgentData } from './ui/useAgentData';
import { PATTERNS, type Route } from './ui/patterns';

/** VITE_API_BASE を指定したとき（実際の API につなぐとき）はモックの設定を出さない */
const USE_MOCK = !import.meta.env.VITE_API_BASE;

function readRoute(): Route {
  const h = window.location.hash.replace(/^#\/?/, '');
  return h === 'chat' || h === 'inbox' || h === 'console' ? h : 'overview';
}

export function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const [toast, setToast] = useState<string>();
  const userId = DEMO_USER;
  const data = useAgentData(userId);

  useEffect(() => {
    const on = () => {
      setRoute(readRoute());
    };
    window.addEventListener('hashchange', on);
    return () => {
      window.removeEventListener('hashchange', on);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => {
      setToast(undefined);
    }, 3500);
    return () => {
      clearTimeout(t);
    };
  }, [toast]);

  return (
    <div className={`app route-${route}`}>
      <header className="topbar">
        <a className="brand" href="#/">
          <span className="brand-mark" aria-hidden>
            ◐
          </span>
          Always-on Agent
          <span className="brand-sub">UI モック</span>
        </a>
        <nav className="tabs" aria-label="パターン">
          {PATTERNS.map((p) => (
            <a key={p.route} href={`#/${p.route}`} className={`tab ${route === p.route ? 'tab-active' : ''}`}>
              <span className="tab-letter">{p.letter}</span>
              {p.name}
            </a>
          ))}
        </nav>
        <div className="topbar-right">
          <span className="user-chip" title="userId">
            {userId}
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
        {route === 'overview' && <Overview data={data} />}
        {route === 'chat' && <ChatPattern userId={userId} data={data} />}
        {route === 'inbox' && <InboxPattern userId={userId} data={data} />}
        {route === 'console' && <ConsolePattern userId={userId} data={data} />}
      </main>
      {toast && <Toast>{toast}</Toast>}
    </div>
  );
}

/** モックの設定（シナリオの切り替え、データの初期化、Webhook の送信）。実際の API につなぐときは出さない */
function MockPanel({ userId, onPosted }: { userId: string; onPosted: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [scenario, setScenario] = useState<ScenarioId>(() => getState().scenario);

  const send = async (id: string) => {
    const sample = SAMPLE_EVENTS.find((s) => s.id === id);
    if (!sample) return;
    try {
      const res = await postEvent(userId, sample.body());
      onPosted(
        res.duplicate
          ? `重複として受け付けました（duplicate: true, eventId ${res.eventId.slice(0, 8)}…）`
          : `「${sample.label}」を送りました（202）`,
      );
    } catch (err) {
      onPosted(err instanceof ApiError ? `送信に失敗: ${err.message}` : '送信に失敗しました');
    }
  };

  return (
    <div className="mock-panel">
      <button
        type="button"
        className="btn btn-mock"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        モック設定
        <span className="mock-scenario">{SCENARIOS[scenario].label}</span>
      </button>
      {open && (
        <div className="mock-popover" role="dialog" aria-label="モック設定">
          <section>
            <h3>シナリオ</h3>
            <p className="muted">切り替えるとデータを初期状態に戻します。</p>
            <div className="scenario-list">
              {Object.values(SCENARIOS).map((s) => (
                <label key={s.id} className={`scenario ${scenario === s.id ? 'scenario-active' : ''}`}>
                  <input
                    type="radio"
                    name="scenario"
                    checked={scenario === s.id}
                    onChange={() => {
                      setScenario(s.id);
                      resetState(s.id);
                      resumeAll();
                      onPosted(`シナリオ「${s.label}」に切り替えました`);
                    }}
                  />
                  <span>
                    <strong>{s.label}</strong>
                    <span className="muted">{s.description}</span>
                  </span>
                </label>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                resetState(scenario);
                resumeAll();
                onPosted('データを初期状態に戻しました');
              }}
            >
              このシナリオを最初からやり直す
            </button>
          </section>
          <section>
            <h3>Webhook を送る</h3>
            <p className="muted">外部サービスから届いたことにして POST /users/{userId}/events に送ります。</p>
            <div className="sample-list">
              {SAMPLE_EVENTS.map((s) => (
                <button key={s.id} type="button" className="sample" onClick={() => void send(s.id)}>
                  <strong>{s.label}</strong>
                  <span className="muted">{s.hint}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
