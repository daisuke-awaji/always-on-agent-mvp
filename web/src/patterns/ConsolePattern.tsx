import { ChevronDown } from 'lucide-react';
import { useMemo, useState, type SyntheticEvent } from 'react';
import { ApiError, postEvent } from '../api/client';
import type { EventType, InboxEvent, PostEventBody } from '../api/schema';
import { OutcomeBadge, PHONE, SourceAvatar, StatusBadge, useMediaQuery } from '../ui/components';
import {
  buildRuns,
  clock,
  countByStatus,
  dayLabel,
  OUTCOME_LABEL,
  relativeTime,
  summarize,
  type Run,
  type RunOutcome,
} from '../ui/derive';
import { useNow, type AgentData } from '../ui/useAgentData';

/**
 * パターン C: 運用。イベントと run の流れをそのまま見せる、開発・運用向けの画面。
 * 右側のフォームから任意のイベントを送り、受付の応答（202 / duplicate / 400）をその場で確かめられる。
 */
type OutcomeFilter = 'all' | RunOutcome;

export function ConsolePattern({ userId, data }: { userId: string; data: AgentData }) {
  const now = useNow(5_000);
  const [filter, setFilter] = useState<OutcomeFilter>('all');
  const [openRun, setOpenRun] = useState<string>();
  const runs = useMemo(() => buildRuns(data.events, data.messages), [data.events, data.messages]);
  const c = countByStatus(data.events);
  const finished = runs.filter((r) => r.outcome === 'sent' || r.outcome === 'silent');
  const sentRatio = finished.length
    ? Math.round((finished.filter((r) => r.outcome === 'sent').length / finished.length) * 100)
    : 0;
  const shown = runs.filter((r) => filter === 'all' || r.outcome === filter);
  const outcomes: OutcomeFilter[] = ['all', 'queued', 'running', 'retrying', 'sent', 'silent', 'failed'];

  return (
    <div className="console">
      <div className="metrics">
        <Metric label="待ち" value={c.pending} tone={c.pending ? 'info' : undefined} />
        <Metric label="処理中" value={c.processing} tone={c.processing ? 'info' : undefined} />
        <Metric label="完了" value={c.done} />
        <Metric label="失敗" value={c.failed} tone={c.failed ? 'bad' : undefined} />
        <Metric label="送信した run の割合" value={`${sentRatio}%`} sub={`${finished.length} run 中`} />
        <Metric label="メッセージ" value={data.messages.length} />
      </div>

      <div className="console-body">
        <section className="runs" aria-label="run の一覧">
          <div className="runs-head">
            <h2>run</h2>
            <div className="chips" role="group" aria-label="結果で絞り込む">
              {outcomes.map((o) => (
                <button
                  key={o}
                  type="button"
                  aria-pressed={filter === o}
                  className={`chip ${filter === o ? 'chip-active' : ''}`}
                  onClick={() => {
                    setFilter(o);
                  }}
                >
                  {o === 'all' ? 'すべて' : OUTCOME_LABEL[o]}
                </button>
              ))}
            </div>
          </div>
          <div className="table-wrap">
            <table className="runs-table">
              <thead>
                <tr>
                  <th>受付</th>
                  <th>結果</th>
                  <th>イベント</th>
                  <th className="num">試行</th>
                  <th className="num">送信</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <RunRow
                    key={r.runId}
                    r={r}
                    now={now}
                    open={openRun === r.runId}
                    onToggle={() => {
                      setOpenRun(openRun === r.runId ? undefined : r.runId);
                    }}
                  />
                ))}
              </tbody>
            </table>
            {shown.length === 0 && (
              <p className="muted pad">{data.loaded ? '該当する run はありません' : '読み込み中…'}</p>
            )}
          </div>
        </section>

        <SendForm userId={userId} onSent={data.refresh} />
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: number | string;
  sub?: string;
  tone?: 'info' | 'bad';
}) {
  return (
    <div className={`metric ${tone ? `metric-${tone}` : ''}`}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
      {sub && <span className="metric-sub">{sub}</span>}
    </div>
  );
}

function RunRow({ r, now, open, onToggle }: { r: Run; now: number; open: boolean; onToggle: () => void }) {
  const first = r.events[0];
  const attempts = Math.max(...r.events.map((e) => e.attempts));
  return (
    <>
      <tr className={`run-row ${open ? 'open' : ''} run-${r.outcome}`} onClick={onToggle}>
        <td className="nowrap">
          <button type="button" className="row-toggle" aria-expanded={open} aria-label="詳細">
            {open ? '▾' : '▸'}
          </button>
          <span title={r.startedAt}>
            {dayLabel(r.startedAt)} {clock(r.startedAt)}
          </span>
          <span className="muted small"> {relativeTime(r.startedAt, now)}</span>
        </td>
        <td>
          <OutcomeBadge outcome={r.outcome} />
        </td>
        <td className="run-events">
          {first && <SourceAvatar source={first.source} />}
          <span className="ellipsis">{first ? summarize(first) : ''}</span>
          {r.events.length > 1 && <span className="badge badge-count">+{r.events.length - 1}</span>}
        </td>
        <td className="num" data-label="試行">
          {attempts}
        </td>
        <td className="num" data-label="送信">
          {r.messages.length}
        </td>
      </tr>
      {open && (
        <tr className="run-detail">
          <td colSpan={5}>
            <dl className="kv">
              <dt>runId</dt>
              <dd className="mono">
                {r.runId.startsWith('queued:') ? '（まだ run に入っていない）' : r.runId.split(':')[0]}
              </dd>
              <dt>sessionId</dt>
              <dd className="mono">{r.sessionId ?? '（送信がないので不明）'}</dd>
            </dl>
            {r.events.map((e) => (
              <EventDetail key={e.eventId} e={e} />
            ))}
            {r.messages.map((m) => (
              <div key={m.messageId} className="msg-detail">
                <span className="badge badge-sent">send_message{m.importance === 'high' ? ' · high' : ''}</span>
                <p>{m.text}</p>
              </div>
            ))}
          </td>
        </tr>
      )}
    </>
  );
}

function EventDetail({ e }: { e: InboxEvent }) {
  return (
    <div className="event-detail">
      <div className="event-detail-head">
        <StatusBadge status={e.status} />
        <span className="mono">{e.type}</span>
        <span className="mono">source={e.source}</span>
        {e.sourceEventId && <span className="mono">sourceEventId={e.sourceEventId}</span>}
        <span className="mono">attempts={e.attempts}</span>
      </div>
      {e.lastError && <p className="event-error">lastError: {e.lastError}</p>}
      <pre className="payload">{JSON.stringify(e.payload, null, 2)}</pre>
    </div>
  );
}

const PRESETS: Record<string, { type: EventType; source: string; payload: string }> = {
  github: {
    type: 'webhook',
    source: 'github',
    payload: JSON.stringify(
      { repository: 'dmp-procurement', action: 'opened', pull_request: { number: 98, title: '納品書の取り込み' } },
      null,
      2,
    ),
  },
  user: {
    type: 'user_message',
    source: 'user',
    payload: JSON.stringify({ text: '今週の進捗をまとめてください' }, null, 2),
  },
  system: { type: 'system', source: 'scheduler', payload: JSON.stringify({ kind: 'daily_check' }, null, 2) },
};

/** 任意のイベントを送るフォーム。本文は実際の API の POST /users/{userId}/events と同じ */
function SendForm({ userId, onSent }: { userId: string; onSent: () => void }) {
  const [type, setType] = useState<EventType>('webhook');
  const [source, setSource] = useState('github');
  const [sourceEventId, setSourceEventId] = useState(() => `delivery-${Date.now().toString(36)}`);
  const [sessionId, setSessionId] = useState('');
  const [payload, setPayload] = useState(PRESETS.github?.payload ?? '{}');
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  // スマホでは run の一覧を先に見せたいので、フォームは折りたたんでおく（広い画面では常に開いている）
  const [open, setOpen] = useState(false);
  const phone = useMediaQuery(PHONE);
  const expanded = !phone || open;

  const preset = (k: string) => {
    const p = PRESETS[k];
    if (!p) return;
    setType(p.type);
    setSource(p.source);
    setPayload(p.payload);
  };

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      setResult({ ok: false, text: 'payload が JSON ではありません（送信していません）' });
      return;
    }
    const body: PostEventBody = {
      type,
      source,
      payload: parsed,
      ...(sourceEventId ? { sourceEventId } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
    setBusy(true);
    try {
      const res = await postEvent(userId, body);
      setResult({ ok: true, text: `202 ${JSON.stringify(res, null, 2)}` });
      onSent();
    } catch (err) {
      setResult({
        ok: false,
        text: err instanceof ApiError ? `${err.status} {"error": "${err.message}"}` : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="send-form" aria-label="イベントを送る">
      {phone ? (
        <button
          type="button"
          className="send-form-toggle"
          aria-expanded={open}
          onClick={() => {
            setOpen((v) => !v);
          }}
        >
          <h2>イベントを送る</h2>
          <ChevronDown size={18} className="chevron" aria-hidden />
        </button>
      ) : (
        <h2>イベントを送る</h2>
      )}
      {expanded && (
        <div className="send-form-body">
          <p className="muted mono small">POST /users/{userId}/events</p>
          <div className="chips">
            {Object.keys(PRESETS).map((k) => (
              <button
                key={k}
                type="button"
                className="chip"
                onClick={() => {
                  preset(k);
                }}
              >
                {k}
              </button>
            ))}
          </div>
          <form onSubmit={(e) => void submit(e)}>
            <label>
              type
              <select
                value={type}
                onChange={(e) => {
                  setType(e.target.value as EventType);
                }}
              >
                <option value="webhook">webhook</option>
                <option value="user_message">user_message</option>
                <option value="system">system</option>
              </select>
            </label>
            <label>
              source
              <input
                value={source}
                onChange={(e) => {
                  setSource(e.target.value);
                }}
              />
            </label>
            <label>
              sourceEventId <span className="muted">（同じ値を 2 回送ると duplicate）</span>
              <span className="input-row">
                <input
                  value={sourceEventId}
                  onChange={(e) => {
                    setSourceEventId(e.target.value);
                  }}
                />
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    setSourceEventId(`delivery-${Date.now().toString(36)}`);
                  }}
                >
                  新しい ID
                </button>
              </span>
            </label>
            <label>
              sessionId <span className="muted">（空なら新しい session）</span>
              <input
                value={sessionId}
                onChange={(e) => {
                  setSessionId(e.target.value);
                }}
                placeholder="s-…"
              />
            </label>
            <label>
              payload
              <textarea
                value={payload}
                onChange={(e) => {
                  setPayload(e.target.value);
                }}
                rows={7}
                className="mono"
              />
            </label>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? '送信中…' : '送る'}
            </button>
          </form>
          {result && (
            <pre className={`send-result ${result.ok ? 'ok' : 'ng'}`} role="status">
              {result.text}
            </pre>
          )}
        </div>
      )}
    </aside>
  );
}
