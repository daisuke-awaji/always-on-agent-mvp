import type { EventStatus, InboxEvent, StoredMessage } from '../api/schema';

/**
 * API が返すのは「イベント」と「送信済みメッセージ」の 2 つだけ。
 * 画面で使う「会話（session）」と「run」は、ここで runId と sessionId からつなぎ直す。
 *
 *   ・返信イベントは sessionId を持つ
 *   ・新しい会話のイベントは sessionId を持たない。worker が採番した session は、
 *     同じ runId のメッセージの sessionId からわかる
 *   ・メッセージを送らなかった run（静かにしていた run）は session がわからない
 */

export type TimelineItem =
  { kind: 'event'; at: string; event: InboxEvent } | { kind: 'message'; at: string; message: StoredMessage };

export interface Session {
  sessionId: string;
  title: string;
  lastAt: string;
  items: TimelineItem[];
  busy: boolean;
  hasHigh: boolean;
  failed: number;
}

export type RunOutcome = 'running' | 'queued' | 'sent' | 'silent' | 'failed' | 'retrying';

export interface Run {
  runId: string;
  events: InboxEvent[];
  messages: StoredMessage[];
  sessionId?: string;
  startedAt: string;
  outcome: RunOutcome;
}

export function sessionIdOf(e: InboxEvent, messagesByRun: Map<string, StoredMessage[]>): string | undefined {
  if (e.sessionId) return e.sessionId;
  if (e.runId) return messagesByRun.get(e.runId)?.[0]?.sessionId;
  return undefined;
}

export function indexByRun(messages: StoredMessage[]): Map<string, StoredMessage[]> {
  const m = new Map<string, StoredMessage[]>();
  for (const msg of messages) m.set(msg.runId, [...(m.get(msg.runId) ?? []), msg]);
  return m;
}

const byAt = (a: TimelineItem, b: TimelineItem) => a.at.localeCompare(b.at);

/** 会話の一覧（新しい順）。session がわかるイベントとメッセージだけを入れる */
export function buildSessions(events: InboxEvent[], messages: StoredMessage[]): Session[] {
  const byRun = indexByRun(messages);
  const map = new Map<string, TimelineItem[]>();
  const push = (sid: string, item: TimelineItem) => map.set(sid, [...(map.get(sid) ?? []), item]);
  for (const e of events) {
    const sid = sessionIdOf(e, byRun);
    if (sid) push(sid, { kind: 'event', at: e.receivedAt, event: e });
  }
  for (const m of messages) push(m.sessionId, { kind: 'message', at: m.createdAt, message: m });

  const sessions = [...map.entries()].map(([sessionId, items]): Session => {
    items.sort(byAt);
    const firstEvent = items.find((i): i is Extract<TimelineItem, { kind: 'event' }> => i.kind === 'event');
    const firstMessage = items.find((i): i is Extract<TimelineItem, { kind: 'message' }> => i.kind === 'message');
    const title = firstEvent ? summarize(firstEvent.event) : firstLine(firstMessage?.message.text ?? '');
    const evs = items.flatMap((i) => (i.kind === 'event' ? [i.event] : []));
    return {
      sessionId,
      title,
      lastAt: items.at(-1)?.at ?? '',
      items,
      busy: evs.some((e) => e.status === 'pending' || e.status === 'processing'),
      hasHigh: items.some((i) => i.kind === 'message' && i.message.importance === 'high'),
      failed: evs.filter((e) => e.status === 'failed').length,
    };
  });
  return sessions.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

/** run の一覧（新しい順）。まだ run に入っていないイベントは runId なしの「待ち」として 1 件ずつ並べる */
export function buildRuns(events: InboxEvent[], messages: StoredMessage[]): Run[] {
  const byRun = indexByRun(messages);
  const groups = new Map<string, InboxEvent[]>();
  const runs: Run[] = [];
  for (const e of events) {
    if (!e.runId || e.status === 'pending') {
      runs.push({
        runId: e.runId ? `${e.runId}:retry:${e.eventId}` : `queued:${e.eventId}`,
        events: [e],
        messages: [],
        sessionId: e.sessionId,
        startedAt: e.receivedAt,
        outcome: e.runId ? 'retrying' : 'queued',
      });
      continue;
    }
    groups.set(e.runId, [...(groups.get(e.runId) ?? []), e]);
  }
  for (const [runId, evs] of groups) {
    const msgs = byRun.get(runId) ?? [];
    evs.sort((a, b) => a.sk.localeCompare(b.sk));
    runs.push({
      runId,
      events: evs,
      messages: msgs,
      sessionId: msgs[0]?.sessionId ?? evs[0]?.sessionId,
      startedAt: evs[0]?.receivedAt ?? '',
      outcome: outcomeOf(evs, msgs),
    });
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function outcomeOf(evs: InboxEvent[], msgs: StoredMessage[]): RunOutcome {
  if (evs.some((e) => e.status === 'processing')) return 'running';
  if (evs.some((e) => e.status === 'failed')) return 'failed';
  return msgs.length > 0 ? 'sent' : 'silent';
}

export function countByStatus(events: InboxEvent[]): Record<EventStatus, number> {
  const c: Record<EventStatus, number> = { pending: 0, processing: 0, done: 0, failed: 0 };
  for (const e of events) c[e.status] += 1;
  return c;
}

// ---- 表示用の文言 ----

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

const GH_ACTIONS: Record<string, string> = {
  review_requested: 'レビュー依頼',
  opened: '作成',
  closed: 'クローズ',
  merged: 'マージ',
  synchronize: '更新',
  failure: 'CI 失敗',
};

/** イベントを 1 行で説明する */
export function summarize(e: InboxEvent): string {
  const p = rec(e.payload);
  if (e.type === 'user_message') return firstLine(str(p?.text) ?? '');
  if (e.source === 'github' && p) {
    const pr = rec(p.pull_request);
    const num = typeof pr?.number === 'number' ? ` #${pr.number}` : '';
    const action = str(p.action) ?? '';
    return `${str(p.repository) ?? 'GitHub'}${num} ${GH_ACTIONS[action] ?? action}`.trim();
  }
  if (e.source === 'backlog' && p) return `${str(p.issue) ?? 'Backlog'} にコメント`;
  if (e.type === 'system' && p) return str(p.kind) === 'daily_check' ? '定期チェック' : (str(p.kind) ?? 'システム');
  return `${e.source} からの通知`;
}

export function detailOf(e: InboxEvent): string | undefined {
  const p = rec(e.payload);
  if (!p) return undefined;
  if (e.type === 'user_message') return str(p.text);
  const pr = rec(p.pull_request);
  return str(pr?.title) ?? str(p.comment);
}

export const SOURCE_LABEL: Record<string, string> = {
  user: 'あなた',
  github: 'GitHub',
  backlog: 'Backlog',
  scheduler: 'スケジューラ',
};

export const STATUS_LABEL: Record<EventStatus, string> = {
  pending: '受付済み',
  processing: '処理中',
  done: '完了',
  failed: '失敗',
};

export const OUTCOME_LABEL: Record<RunOutcome, string> = {
  queued: '待ち',
  retrying: '再試行待ち',
  running: '実行中',
  sent: '送信あり',
  silent: '静かに完了',
  failed: '失敗',
};

export function firstLine(s: string, max = 60): string {
  const line = s.split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const sec = Math.round((now - new Date(iso).getTime()) / 1000);
  if (sec < 10) return 'たった今';
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 時間前`;
  return `${Math.floor(h / 24)} 日前`;
}

export function clock(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86_400_000);
  if (diff === 0) return '今日';
  if (diff === 1) return '昨日';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
