import { ChevronDown, ChevronRight, RefreshCw, Send } from 'lucide-react';
import { useMemo, useState, type SyntheticEvent } from 'react';
import { Badge } from '@/components/ui/badge-clean';
import { Button } from '@/components/ui/button-clean';
import { CodeBlock } from '@/components/ui/code-block-clean';
import { IconButton } from '@/components/ui/icon-button-clean';
import { Select } from '@/components/ui/select-clean';
import { TextArea } from '@/components/ui/text-area-clean';
import { TextField } from '@/components/ui/text-field-clean';
import { ToggleGroup } from '@/components/ui/toggle-group-clean';
import { ToolCallCard, ToolCallGroup } from '@/components/ui/tool-call-card-clean';
import { ApiError, postEvent } from '../api/client';
import type { EventType, InboxEvent, PostEventBody, StoredMessage } from '../api/schema';
import { ListSkeleton, OutcomeBadge, PHONE, SourceAvatar, StatusBadge, useMediaQuery } from '../ui/components';
import {
  buildRuns,
  clock,
  countByStatus,
  dayLabel,
  firstLine,
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
const OUTCOMES: RunOutcome[] = ['queued', 'running', 'retrying', 'sent', 'silent', 'failed'];
const ALL = 'all';

export function ConsolePattern({ userId, data }: { userId: string; data: AgentData }) {
  const now = useNow(5_000);
  const phone = useMediaQuery(PHONE);
  // 何も選んでいないときは全部。もう一度押すと外れる
  const [filter, setFilter] = useState<RunOutcome | null>(null);
  const [openRun, setOpenRun] = useState<string>();
  const runs = useMemo(() => buildRuns(data.events, data.messages), [data.events, data.messages]);
  const c = countByStatus(data.events);
  const finished = runs.filter((r) => r.outcome === 'sent' || r.outcome === 'silent');
  const sentRatio = finished.length
    ? Math.round((finished.filter((r) => r.outcome === 'sent').length / finished.length) * 100)
    : 0;
  const shown = runs.filter((r) => filter === null || r.outcome === filter);

  return (
    <div className="console">
      <div className="metrics">
        <Metric label="待ち" value={c.pending} />
        <Metric label="処理中" value={c.processing} />
        <Metric label="完了" value={c.done} />
        <Metric label="失敗" value={c.failed} />
        <Metric label="送信率" value={`${sentRatio}%`} sub={`終わった ${String(finished.length)} run 中`} />
        <Metric label="メッセージ" value={data.messages.length} />
      </div>

      <div className="console-body">
        <section className="runs" aria-label="run の一覧">
          <div className="runs-head">
            <h2>run</h2>
            {/* 狭い画面では 6 つのボタンが折り返して崩れるので、選ぶ形にする */}
            {phone ? (
              <Select
                aria-label="結果で絞り込む"
                className="runs-filter"
                size="sm"
                options={[
                  { value: ALL, label: 'すべての結果' },
                  ...OUTCOMES.map((o) => ({ value: o, label: OUTCOME_LABEL[o] })),
                ]}
                value={filter ?? ALL}
                onChange={(v) => {
                  setFilter(v === ALL ? null : (v as RunOutcome));
                }}
              />
            ) : (
              <ToggleGroup<RunOutcome>
                type="single"
                aria-label="結果で絞り込む"
                size="sm"
                value={filter}
                onChange={setFilter}
                items={OUTCOMES.map((o) => ({ value: o, label: OUTCOME_LABEL[o] }))}
              />
            )}
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
            {!data.loaded && <ListSkeleton label="run を読み込み中" />}
            {data.loaded && shown.length === 0 && (
              <p className="muted pad">
                該当する run はありません
                {filter !== null && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFilter(null);
                    }}
                  >
                    絞り込みを外す
                  </Button>
                )}
              </p>
            )}
          </div>
        </section>

        <SendForm userId={userId} onSent={data.refresh} />
      </div>
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
      {sub && <span className="metric-sub">{sub}</span>}
    </div>
  );
}

function RunRow({ r, now, open, onToggle }: { r: Run; now: number; open: boolean; onToggle: () => void }) {
  const first = r.events.at(0);
  const attempts = Math.max(...r.events.map((e) => e.attempts));
  return (
    <>
      <tr className={`run-row ${open ? 'open' : ''} run-${r.outcome}`} onClick={onToggle}>
        <td className="nowrap">
          <IconButton
            size="sm"
            className="row-toggle"
            label={open ? '詳細を閉じる' : '詳細を開く'}
            title=""
            aria-expanded={open}
            icon={open ? <ChevronDown size={14} strokeWidth={2} /> : <ChevronRight size={14} strokeWidth={2} />}
          />
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
          {r.events.length > 1 && (
            <Badge aria-label={`ほか ${String(r.events.length - 1)} 件`}>+{r.events.length - 1}</Badge>
          )}
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
            {r.messages.length > 0 && <SendCalls messages={r.messages} />}
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
      <CodeBlock language="json" filename="payload" code={JSON.stringify(e.payload, null, 2)} maxHeight={220} />
    </div>
  );
}

/**
 * エージェントが run の中で呼んだ send_message。引数はツールの入力（text・importance）、
 * 結果は実際のツールが返す文字列と同じ形（src/agent/loop.ts の "sent (messageId=…)"）
 */
function SendCalls({ messages }: { messages: StoredMessage[] }) {
  const cards = messages.map((m) => (
    <ToolCallCard
      key={m.messageId}
      name="send_message"
      icon={<Send size={16} strokeWidth={1.9} />}
      summary={firstLine(m.text, 48)}
      status="success"
      args={{ text: m.text, importance: m.importance }}
      result={`sent (messageId=${m.messageId})`}
    />
  ));
  if (cards.length === 1) return <div className="send-calls">{cards}</div>;
  return (
    <ToolCallGroup className="send-calls" label={`send_message を ${String(cards.length)} 回`}>
      {cards}
    </ToolCallGroup>
  );
}

const PRESETS: Partial<Record<string, { type: EventType; source: string; payload: string }>> = {
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

const EVENT_TYPES = [
  { value: 'webhook', label: 'webhook', description: '外部サービスからの通知' },
  { value: 'user_message', label: 'user_message', description: 'あなたからのメッセージ' },
  { value: 'system', label: 'system', description: '定期実行など、システムから' },
];

/** 任意のイベントを送るフォーム。本文は実際の API の POST /users/{userId}/events と同じ */
function SendForm({ userId, onSent }: { userId: string; onSent: () => void }) {
  const [type, setType] = useState<EventType>('webhook');
  const [source, setSource] = useState('github');
  const [sourceEventId, setSourceEventId] = useState(() => `delivery-${Date.now().toString(36)}`);
  const [sessionId, setSessionId] = useState('');
  const [payload, setPayload] = useState(PRESETS.github?.payload ?? '{}');
  const [result, setResult] = useState<{ ok: boolean; status: string; body: string }>();
  const [payloadError, setPayloadError] = useState<string>();
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

  const submit = async (e?: SyntheticEvent) => {
    e?.preventDefault();
    if (busy) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      setPayloadError('JSON ではないので送っていません');
      return;
    }
    setPayloadError(undefined);
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
      setResult({ ok: true, status: '202 Accepted', body: JSON.stringify(res, null, 2) });
      onSent();
    } catch (err) {
      setResult(
        err instanceof ApiError
          ? { ok: false, status: String(err.status), body: JSON.stringify({ error: err.message }, null, 2) }
          : { ok: false, status: 'エラー', body: String(err) },
      );
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
          <code className="endpoint">POST /users/{userId}/events</code>
          <div className="presets" role="group" aria-label="ひな形">
            {Object.keys(PRESETS).map((k) => (
              <Button
                key={k}
                variant="secondary"
                size="sm"
                onClick={() => {
                  preset(k);
                }}
              >
                {k}
              </Button>
            ))}
          </div>
          <form onSubmit={(e) => void submit(e)}>
            <Select
              label="type"
              options={EVENT_TYPES}
              value={type}
              onChange={(v) => {
                setType(v as EventType);
              }}
            />
            <TextField
              label="source"
              inputClassName="mono-input"
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
              }}
            />
            <TextField
              label="sourceEventId"
              hint="同じ値を 2 回送ると duplicate になる"
              optional
              inputClassName="mono-input"
              value={sourceEventId}
              onChange={(e) => {
                setSourceEventId(e.target.value);
              }}
              suffix={
                <IconButton
                  size="sm"
                  label="新しい ID にする"
                  icon={<RefreshCw size={14} strokeWidth={1.9} />}
                  onClick={() => {
                    setSourceEventId(`delivery-${Date.now().toString(36)}`);
                  }}
                />
              }
            />
            <TextField
              label="sessionId"
              hint="空なら新しい session"
              optional
              placeholder="s-…"
              inputClassName="mono-input"
              value={sessionId}
              clearable
              onChange={(e) => {
                setSessionId(e.target.value);
              }}
            />
            <TextArea
              label="payload"
              hint="JSON"
              inputClassName="mono-input"
              minRows={6}
              maxRows={16}
              expandable
              value={payload}
              error={payloadError}
              onChange={(e) => {
                setPayload(e.target.value);
              }}
              onSubmitShortcut={() => {
                void submit();
              }}
            />
            <Button type="submit" loading={busy} icon={<Send size={14} strokeWidth={1.9} />}>
              送る
            </Button>
          </form>
          {result && (
            <div className="send-result" role="status">
              <Badge tone={result.ok ? 'success' : 'danger'}>{result.status}</Badge>
              <CodeBlock language="json" code={result.body} wrap />
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
