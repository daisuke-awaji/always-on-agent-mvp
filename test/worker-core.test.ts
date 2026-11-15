import { describe, expect, it, vi } from 'vitest';
import { groupIntoRuns, processUser, type WorkerDeps } from '../src/functions/worker-core.js';
import type { RunRequest, RunResult } from '../src/shared/types.js';
import { InMemoryInbox, InMemoryMessages } from './fakes.js';

const opts = { owner: 'w1', leaseMs: 60_000, maxRounds: 5, maxAttempts: 3, recentMessages: 5 };

function setup(invoke?: (req: RunRequest) => Promise<RunResult>) {
  const inbox = new InMemoryInbox();
  const messages = new InMemoryMessages();
  const calls: RunRequest[] = [];
  let n = 0;
  const deps: WorkerDeps = {
    inbox,
    messages,
    invokeRun: async (req) => {
      calls.push(req);
      if (invoke) return invoke(req);
      return ok(req);
    },
    rewake: vi.fn(async () => {}),
    newId: () => `run-${++n}`,
    newSessionId: () => `s-00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`,
    canStartRun: () => true,
    log: () => {},
  };
  return { inbox, messages, deps, calls };
}

const ok = (req: RunRequest): RunResult => ({
  runId: req.runId,
  sessionId: req.sessionId,
  outcome: 'silent',
  messagesSent: 0,
  turns: 1,
  stopReason: 'end_turn',
  usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
});

const SID = 's-11111111-1111-1111-1111-111111111111';

describe('groupIntoRuns', () => {
  it('sessionId 付きは既存 session ごと、それ以外は 1 つの新規 session にまとめる', async () => {
    const inbox = new InMemoryInbox();
    await inbox.appendEvent({ userId: 'u', type: 'webhook', source: 'gh', payload: 1 });
    await inbox.appendEvent({ userId: 'u', type: 'user_message', source: 'user', sessionId: SID, payload: 2 });
    await inbox.appendEvent({ userId: 'u', type: 'webhook', source: 'gh', payload: 3 });
    const batches = groupIntoRuns(await inbox.listOpenEvents('u'), () => 's-new');
    expect(batches).toHaveLength(2);
    // 最初に届いたイベント（payload 1）を含む新規 session が先
    expect(batches[0]).toMatchObject({ sessionId: 's-new', resume: false });
    expect(batches[0]!.events.map((e) => e.payload)).toEqual([1, 3]);
    expect(batches[1]).toMatchObject({ sessionId: SID, resume: true });
  });
});

describe('processUser', () => {
  it('連続して届いたイベントを 1 回の run にまとめ、done にしてリースを解放する', async () => {
    const { inbox, deps, calls } = setup();
    for (const t of ['a', 'b', 'c']) await inbox.appendEvent({ userId: 'u', type: 'user_message', source: 'user', payload: { text: t } });
    const res = await processUser('u', deps, opts);
    expect(res.status).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.events.map((e) => (e.payload as { text: string }).text)).toEqual(['a', 'b', 'c']);
    expect((await inbox.listRecentEvents('u', 10)).every((e) => e.status === 'done')).toBe(true);
    expect(inbox.leases.size).toBe(0);
  });

  it('直近の送信メッセージを古い順に渡す', async () => {
    const { inbox, messages, deps, calls } = setup();
    await messages.put({ userId: 'u', sessionId: SID, runId: 'r0', text: 'first', importance: 'normal' });
    await messages.put({ userId: 'u', sessionId: SID, runId: 'r0', text: 'second', importance: 'normal' });
    await inbox.appendEvent({ userId: 'u', type: 'user_message', source: 'user', payload: {} });
    await processUser('u', deps, opts);
    expect(calls[0]!.recentMessages.map((m) => m.text)).toEqual(['first', 'second']);
  });

  it('他の worker がリースを持っていれば何もしない（inbox ごとに worker は 1 つ）', async () => {
    const { inbox, deps, calls } = setup();
    await inbox.appendEvent({ userId: 'u', type: 'user_message', source: 'user', payload: {} });
    await inbox.acquireLease('u', 'other', 60_000);
    expect(await processUser('u', deps, opts)).toEqual({ status: 'lease_busy' });
    expect(calls).toHaveLength(0);
  });

  it('期限切れのリースは奪い、前の worker が残した processing を拾い直す', async () => {
    let now = 1_000_000;
    const { deps, calls } = setup();
    const inbox = new InMemoryInbox(() => now);
    deps.inbox = inbox;
    const { event } = await inbox.appendEvent({ userId: 'u', type: 'user_message', source: 'user', payload: {} });
    await inbox.acquireLease('u', 'dead-worker', 10_000);
    await inbox.markProcessing('u', [event], 'dead-run'); // 途中で落ちた
    now += 20_000;
    const res = await processUser('u', deps, opts);
    expect(res.status).toBe('ok');
    expect(calls).toHaveLength(1);
    expect((await inbox.listRecentEvents('u', 1))[0]).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('run 中に届いたイベントは次のラウンドで拾う', async () => {
    const { inbox, deps, calls } = setup();
    await inbox.appendEvent({ userId: 'u', type: 'user_message', source: 'user', payload: { text: 'first' } });
    deps.invokeRun = async (req) => {
      calls.push(req);
      if (calls.length === 1) await inbox.appendEvent({ userId: 'u', type: 'webhook', source: 'gh', payload: { text: 'late' } });
      return ok(req);
    };
    await processUser('u', deps, opts);
    expect(calls.map((c) => (c.events[0]!.payload as { text: string }).text)).toEqual(['first', 'late']);
  });

  it('失敗した run は pending に戻して再試行し、上限に達したら failed にする', async () => {
    const { inbox, deps, calls } = setup(async () => {
      throw new Error('boom');
    });
    await inbox.appendEvent({ userId: 'u', type: 'user_message', source: 'user', payload: {} });
    const res = await processUser('u', deps, opts);
    expect(calls).toHaveLength(3);
    expect(res.status === 'ok' && res.runs.every((r) => !r.ok)).toBe(true);
    expect((await inbox.listRecentEvents('u', 1))[0]).toMatchObject({ status: 'failed', attempts: 3, lastError: 'boom' });
    expect(inbox.leases.size).toBe(0);
  });

  it('一時的な失敗なら次の試行で成功する', async () => {
    let n = 0;
    const { inbox, deps } = setup(async (req) => {
      if (++n === 1) throw new Error('throttled');
      return ok(req);
    });
    await inbox.appendEvent({ userId: 'u', type: 'user_message', source: 'user', payload: {} });
    await processUser('u', deps, opts);
    expect((await inbox.listRecentEvents('u', 1))[0]).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('残り時間が足りなければ run を始めず、wake を送り直して次回に回す', async () => {
    const { inbox, deps, calls } = setup();
    await inbox.appendEvent({ userId: 'u', type: 'user_message', source: 'user', payload: {} });
    deps.canStartRun = () => false;
    const res = await processUser('u', deps, opts);
    expect(res).toMatchObject({ status: 'ok', rewoken: true });
    expect(calls).toHaveLength(0);
    expect(deps.rewake).toHaveBeenCalledWith('u');
    expect((await inbox.listOpenEvents('u'))[0]!.status).toBe('pending');
    expect(inbox.leases.size).toBe(0);
  });

  it('予期しない例外でもリースは解放する', async () => {
    const { inbox, deps } = setup();
    await inbox.appendEvent({ userId: 'u', type: 'user_message', source: 'user', payload: {} });
    deps.inbox.listOpenEvents = async () => {
      throw new Error('ddb down');
    };
    await expect(processUser('u', deps, opts)).rejects.toThrow('ddb down');
    expect(inbox.leases.size).toBe(0);
  });

  it('イベントがなければ run しない', async () => {
    const { deps, calls } = setup();
    expect(await processUser('u', deps, opts)).toEqual({ status: 'ok', runs: [], rewoken: false });
    expect(calls).toHaveLength(0);
  });
});
