import { describe, expect, it } from 'vitest';
import type { InboxEvent, StoredMessage } from '../api/schema';
import { buildRuns, buildSessions, summarize } from './derive';

let n = 0;
function ev(p: Partial<InboxEvent>): InboxEvent {
  n += 1;
  const receivedAt = p.receivedAt ?? `2026-11-15T00:00:${String(n).padStart(2, '0')}.000Z`;
  const eventId = p.eventId ?? `e${n}`;
  return {
    eventId,
    userId: 'alice',
    type: 'user_message',
    source: 'user',
    payload: { text: `text ${n}` },
    status: 'done',
    attempts: 1,
    updatedAt: receivedAt,
    sk: `EVT#${receivedAt}#${eventId}`,
    ...p,
    receivedAt,
  };
}
function msg(p: Partial<StoredMessage> & Pick<StoredMessage, 'runId' | 'sessionId'>): StoredMessage {
  n += 1;
  return {
    messageId: `m${n}`,
    userId: 'alice',
    importance: 'normal',
    text: `reply ${n}`,
    createdAt: `2026-11-15T00:01:${String(n).padStart(2, '0')}.000Z`,
    ...p,
  };
}

describe('buildSessions', () => {
  it('新しい会話のイベントは、同じ runId のメッセージから session を知る', () => {
    const first = ev({ runId: 'r1' });
    const reply = ev({ runId: 'r2', sessionId: 's-1' });
    const sessions = buildSessions([first, reply], [msg({ runId: 'r1', sessionId: 's-1' })]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.items.map((i) => i.kind)).toEqual(['event', 'event', 'message']);
  });

  it('送信のない run のイベントはどの会話にも入らない', () => {
    const silent = ev({
      type: 'webhook',
      source: 'github',
      runId: 'r9',
      payload: { repository: 'x', action: 'opened' },
    });
    expect(buildSessions([silent], [])).toEqual([]);
  });

  it('処理中のイベントがある会話は busy、high のメッセージがあれば hasHigh', () => {
    const e = ev({ sessionId: 's-2', status: 'processing', runId: 'r3' });
    const s = buildSessions([e], [msg({ runId: 'r0', sessionId: 's-2', importance: 'high' })]);
    expect(s[0]).toMatchObject({ busy: true, hasHigh: true });
  });
});

describe('buildRuns', () => {
  it('runId ごとにまとめ、送信の有無で結果を分ける', () => {
    const a = ev({ runId: 'r1' });
    const b = ev({ runId: 'r1', type: 'webhook', source: 'github', payload: {} });
    const c = ev({ runId: 'r2', type: 'system', source: 'scheduler', payload: { kind: 'daily_check' } });
    const runs = buildRuns([a, b, c], [msg({ runId: 'r1', sessionId: 's-1' })]);
    const byId = Object.fromEntries(runs.map((r) => [r.runId, r]));
    expect(byId.r1?.outcome).toBe('sent');
    expect(byId.r1?.events).toHaveLength(2);
    expect(byId.r2?.outcome).toBe('silent');
  });

  it('まだ run に入っていないイベントは待ち、失敗して戻ったものは再試行待ち', () => {
    const queued = ev({ status: 'pending', attempts: 0 });
    const retry = ev({ status: 'pending', attempts: 1, runId: 'r5', lastError: 'Throttling' });
    const failed = ev({ status: 'failed', attempts: 3, runId: 'r6' });
    const outcomes = buildRuns([queued, retry, failed], [])
      .map((r) => r.outcome)
      .sort();
    expect(outcomes).toEqual(['failed', 'queued', 'retrying']);
  });
});

describe('summarize', () => {
  it('GitHub の Webhook を 1 行にする', () => {
    const e = ev({
      type: 'webhook',
      source: 'github',
      payload: { repository: 'dmp-procurement', action: 'review_requested', pull_request: { number: 91 } },
    });
    expect(summarize(e)).toBe('dmp-procurement #91 レビュー依頼');
  });
});
