import type { InboxRepository } from '../shared/inbox-repo.js';
import type { MessageRepository } from '../shared/message-repo.js';
import type { InboxEvent, RunRequest, RunResult } from '../shared/types.js';

/**
 * Worker 本体（記事: "A worker, usually a background service, that reads from the list"）。
 *
 * 記事のベストプラクティスとの対応:
 *  - inbox ごとにアクティブな worker は 1 つ … SQS FIFO の MessageGroupId と DynamoDB のリース
 *  - inbox が正                              … 起きたら毎回 inbox から未処理イベントを読み直す
 *  - 落ちた worker の後始末                  … リース期限切れ後、残った processing を拾い直す
 *  - pending をまとめて処理                  … 1 回の run に複数イベントを渡す
 *  - run 中に届いたイベント                  … 「次の run に回す」方式（ラウンドを回して拾う）
 */
export interface WorkerDeps {
  inbox: InboxRepository;
  messages: Pick<MessageRepository, 'listRecent'>;
  invokeRun: (req: RunRequest) => Promise<RunResult>;
  /** 時間切れで途中終了するとき、自分宛てに wake 信号を送り直す */
  rewake: (userId: string) => Promise<void>;
  newId: () => string;
  newSessionId: () => string;
  /** 新しい run を始めてよいか（Lambda の残り時間など） */
  canStartRun: () => boolean;
  log: (msg: string, data?: Record<string, unknown>) => void;
}

export interface WorkerOptions {
  owner: string;
  leaseMs: number;
  maxRounds: number;
  maxAttempts: number;
  recentMessages: number;
}

export interface RunSummary {
  runId: string;
  sessionId: string;
  eventIds: string[];
  ok: boolean;
  outcome?: RunResult['outcome'];
  error?: string;
}

export type ProcessResult = { status: 'lease_busy' } | { status: 'ok'; runs: RunSummary[]; rewoken: boolean };

export interface RunBatch {
  sessionId: string;
  resume: boolean;
  events: InboxEvent[];
}

/**
 * 未処理イベントを run 単位にまとめる。
 * 記事: "Events that continue earlier work, such as a reply from the user, resume an existing session,
 *        while everything else starts a new session."
 */
export function groupIntoRuns(events: InboxEvent[], newSessionId: () => string): RunBatch[] {
  const bySession = new Map<string, InboxEvent[]>();
  const fresh: InboxEvent[] = [];
  for (const e of events) {
    if (e.sessionId) {
      const list = bySession.get(e.sessionId) ?? [];
      list.push(e);
      bySession.set(e.sessionId, list);
    } else {
      fresh.push(e);
    }
  }
  const batches: RunBatch[] = [...bySession.entries()].map(([sessionId, evs]) => ({
    sessionId,
    resume: true,
    events: evs,
  }));
  if (fresh.length > 0) batches.push({ sessionId: newSessionId(), resume: false, events: fresh });
  // 先に届いたイベントを含む run から順に処理する
  return batches.sort((a, b) => a.events[0].receivedAt.localeCompare(b.events[0].receivedAt));
}

export async function processUser(userId: string, deps: WorkerDeps, opts: WorkerOptions): Promise<ProcessResult> {
  const acquired = await deps.inbox.acquireLease(userId, opts.owner, opts.leaseMs);
  if (!acquired) {
    deps.log('lease busy', { userId });
    return { status: 'lease_busy' };
  }

  const runs: RunSummary[] = [];
  let rewoken = false;
  try {
    for (let round = 0; round < opts.maxRounds; round++) {
      const open = await deps.inbox.listOpenEvents(userId);
      if (open.length === 0) break;
      if (round > 0) deps.log('picked up events that arrived during previous run', { userId, count: open.length });

      for (const batch of groupIntoRuns(open, deps.newSessionId)) {
        if (!deps.canStartRun()) {
          // 時間切れ。残りは inbox に pending のまま残し、wake 信号を送り直して次回に回す
          await deps.rewake(userId);
          rewoken = true;
          return { status: 'ok', runs, rewoken };
        }
        runs.push(await executeRun(userId, batch, deps, opts));
      }
    }
    // maxRounds を使い切ってもまだ残っている場合も次回に回す
    if (runs.length > 0 && (await deps.inbox.listOpenEvents(userId)).length > 0) {
      await deps.rewake(userId);
      rewoken = true;
    }
    return { status: 'ok', runs, rewoken };
  } finally {
    await deps.inbox.releaseLease(userId, opts.owner);
  }
}

async function executeRun(userId: string, batch: RunBatch, deps: WorkerDeps, opts: WorkerOptions): Promise<RunSummary> {
  const runId = deps.newId();
  const eventIds = batch.events.map((e) => e.eventId);
  await deps.inbox.markProcessing(userId, batch.events, runId);

  try {
    const recent = await deps.messages.listRecent(userId, opts.recentMessages);
    const req: RunRequest = {
      runId,
      userId,
      sessionId: batch.sessionId,
      events: batch.events.map((e) => ({
        eventId: e.eventId,
        type: e.type,
        source: e.source,
        receivedAt: e.receivedAt,
        payload: e.payload,
      })),
      recentMessages: recent.map((m) => ({ createdAt: m.createdAt, sessionId: m.sessionId, text: m.text })).reverse(), // 古い順に並べ替える
    };
    deps.log('run start', { userId, runId, sessionId: batch.sessionId, resume: batch.resume, eventIds });
    const result = await deps.invokeRun(req);
    await deps.inbox.markDone(userId, batch.events, runId);
    deps.log('run done', { userId, runId, outcome: result.outcome, turns: result.turns, usage: result.usage });
    return { runId, sessionId: batch.sessionId, eventIds, ok: true, outcome: result.outcome };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const { failed } = await deps.inbox.markRetry(userId, batch.events, message, opts.maxAttempts);
    deps.log('run failed', { userId, runId, error: message, failedEventIds: failed });
    return { runId, sessionId: batch.sessionId, eventIds, ok: false, error: message };
  }
}
