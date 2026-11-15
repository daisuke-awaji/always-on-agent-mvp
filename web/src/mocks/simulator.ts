import type { InboxEvent, Timer } from '../api/schema';
import { think } from './brain';
import { appendEvent, getState, openEvents, save, usersWithOpenEvents } from './db';
import { applyEffects, refreshTimer } from './records';
import { SCENARIOS } from './scenarios';

/**
 * モックの worker。実際の構成の SQS FIFO + Worker λ + AgentCore Runtime の代わりに、
 * ブラウザの中で次の流れを再現する（src/functions/worker-core.ts と同じ順序）。
 *
 *   wake → リース（ユーザーごとに 1 つ）→ 未処理イベントを session ごとにまとめる
 *   → processing（attempts +1）→ run → done（送信あり / なし）または pending に戻す（3 回で failed）
 *   → run 中に届いたイベントは次のラウンドで拾う
 */
const WAKE_DELAY_MS = 900;
const RUN_MS = [2200, 4200] as const;
const MAX_ATTEMPTS = 3;
const MAX_ROUNDS = 5;

const leased = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const between = ([lo, hi]: readonly [number, number]) => lo + Math.random() * (hi - lo);

/** wake 信号。同じユーザーの worker が動いていれば何もしない（SQS FIFO の MessageGroupId + リース） */
export function wake(userId: string): void {
  if (leased.has(userId)) return;
  leased.add(userId);
  void (async () => {
    try {
      await sleep(WAKE_DELAY_MS);
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const open = openEvents(userId);
        if (open.length === 0) break;
        for (const batch of groupIntoRuns(open)) await executeRun(userId, batch);
      }
    } finally {
      leased.delete(userId);
    }
    // MAX_ROUNDS を使い切っても残っていれば、もう一度 wake する（実際の構成の re-wake）
    if (openEvents(userId).length > 0)
      setTimeout(() => {
        wake(userId);
      }, 1500);
  })();
}

/** 再読み込みで止まった処理を再開する（リースが切れたあとの SQS 再配信の代わり） */
export function resumeAll(): void {
  for (const u of usersWithOpenEvents()) wake(u);
}

interface Batch {
  sessionId: string;
  events: InboxEvent[];
}

/** worker-core.ts の groupIntoRuns と同じ: 既存 session ごとに 1 run、session なしは新しい 1 run にまとめる */
function groupIntoRuns(events: InboxEvent[]): Batch[] {
  const bySession = new Map<string, InboxEvent[]>();
  const fresh: InboxEvent[] = [];
  for (const e of events) {
    if (e.sessionId) bySession.set(e.sessionId, [...(bySession.get(e.sessionId) ?? []), e]);
    else fresh.push(e);
  }
  const batches = [...bySession.entries()].map(([sessionId, evs]) => ({ sessionId, events: evs }));
  if (fresh.length > 0) batches.push({ sessionId: `s-${crypto.randomUUID()}`, events: fresh });
  return batches;
}

async function executeRun(userId: string, batch: Batch): Promise<void> {
  const runId = crypto.randomUUID();
  const ids = new Set(batch.events.map((e) => e.eventId));
  const mine = () => getState().events.filter((e) => ids.has(e.eventId));

  // シナリオが途中で切り替わった（データが作り直された）ら、何もしない
  if (mine().length === 0) return;
  for (const e of mine()) {
    e.status = 'processing';
    e.attempts += 1;
    e.runId = runId;
    e.updatedAt = new Date().toISOString();
  }
  save();

  await sleep(between(RUN_MS));
  const events = mine();
  if (events.length === 0) return;

  const scenario = SCENARIOS[getState().scenario];
  const now = new Date().toISOString();
  if (Math.random() < scenario.runFailureRate) {
    const error =
      Math.random() < 0.5
        ? 'ThrottlingException: Too many requests, please wait before trying again.'
        : 'Runtime returned 502: agent process exited unexpectedly';
    for (const e of events) {
      e.status = e.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      e.lastError = error;
      e.updatedAt = now;
    }
    save();
    await sleep(1500);
    return;
  }

  const { messages, effects } = think(events);
  applyEffects(getState(), userId, batch.sessionId, effects, new Date());
  messages.forEach((m, i) => {
    getState().messages.push({
      messageId: crypto.randomUUID(),
      userId,
      runId,
      sessionId: batch.sessionId,
      importance: m.importance,
      text: m.text,
      createdAt: new Date(Date.now() + i).toISOString(),
    });
  });
  for (const e of events) {
    e.status = 'done';
    e.updatedAt = now;
    delete e.lastError;
  }
  save();
}

// ---- スケジューラ（実際の構成では EventBridge Scheduler） ----
//
// 記事の scheduler と同じ流れ: 時刻が来たタイマーを探す → follow-up は done、schedule は次の回に進める
// → inbox に system イベント（source: scheduler）を入れて worker を起こす。
// 画面を閉じていたあいだに何回分も過ぎていても、動かすのは 1 回だけ（次の回は今より後から数える）。

const TICK_MS = 3000;
let ticking: ReturnType<typeof setInterval> | undefined;

export function startScheduler(): void {
  if (ticking) return;
  tick();
  ticking = setInterval(tick, TICK_MS);
}

/** 時刻が来たタイマーをすべて動かす。動かしたユーザーを返す */
export function tick(now = new Date()): string[] {
  const due = getState().timers.filter((t) => t.status === 'active' && Date.parse(t.dueAt) <= now.getTime());
  for (const t of due) fire(t, now, false);
  const users = [...new Set(due.map((t) => t.userId))];
  if (due.length > 0) save();
  for (const u of users) wake(u);
  return users;
}

/** モック設定の「今すぐ動かす」。schedule は次の回をずらさない（予定外にもう 1 回動かすだけ） */
export function fireNow(timerId: string, now = new Date()): boolean {
  const t = getState().timers.find((x) => x.timerId === timerId && x.status === 'active');
  if (!t) return false;
  fire(t, now, true);
  save();
  wake(t.userId);
  return true;
}

function fire(t: Timer, now: Date, extra: boolean): void {
  // sourceEventId はタイマーと回ごとに決まる値にする。scheduler が同じ回を 2 回入れても、inbox の重複排除で 1 回になる
  const occurrence = extra ? `manual-${now.toISOString()}` : t.dueAt;
  appendEvent(
    {
      userId: t.userId,
      type: 'system',
      source: 'scheduler',
      sourceEventId: `timer:${t.timerId}:${occurrence}`,
      sessionId: t.kind === 'followup' ? t.sessionId : undefined,
      payload: { timerId: t.timerId, kind: t.kind, title: t.title, note: t.note },
    },
    now,
  );
  t.lastFiredAt = now.toISOString();
  if (t.kind === 'followup') {
    t.status = 'done';
    t.updatedAt = now.toISOString();
  } else if (!extra) {
    // 次の回に進める（今より後で、いちばん近い回）
    refreshTimer(t, now);
  } else {
    t.updatedAt = now.toISOString();
  }
}
