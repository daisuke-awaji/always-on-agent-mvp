import { describe, expect, it } from 'vitest';
import type { InboxEvent, StoredMessage } from '../api/schema';
import { buildSessions, detailOf, summarize, totalUnread, unreadIds } from './derive';

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
      source: 'delivery',
      runId: 'r9',
      payload: { carrier: 'ヤマト運輸', status: 'shipped' },
    });
    expect(buildSessions([silent], [])).toEqual([]);
  });

  it('処理中のイベントがある会話は busy、high のメッセージがあれば hasHigh', () => {
    const e = ev({ sessionId: 's-2', status: 'processing', runId: 'r3' });
    const s = buildSessions([e], [msg({ runId: 'r0', sessionId: 's-2', importance: 'high' })]);
    expect(s[0]).toMatchObject({ busy: true, hasHigh: true });
  });
});

describe('unreadIds / totalUnread', () => {
  it('まだ読んでいないエージェントのメッセージだけを数える（自分の発言とイベントは数えない）', () => {
    const first = ev({ runId: 'r1' });
    const webhook = ev({ runId: 'r1', type: 'webhook', source: 'delivery', payload: {} });
    const m1 = msg({ runId: 'r1', sessionId: 's-1' });
    const m2 = msg({ runId: 'r1', sessionId: 's-1' });
    const s = buildSessions([first, webhook], [m1, m2]).at(0);
    if (!s) throw new Error('session がない');
    expect(unreadIds(s, new Set())).toEqual([m1.messageId, m2.messageId]);
    expect(unreadIds(s, new Set([m1.messageId]))).toEqual([m2.messageId]);
    expect(unreadIds(s, new Set([m1.messageId, m2.messageId]))).toEqual([]);
  });

  it('全体の未読数は、会話ごとの未読数の合計', () => {
    const a = msg({ runId: 'r1', sessionId: 's-1' });
    const b = msg({ runId: 'r2', sessionId: 's-2' });
    const c = msg({ runId: 'r3', sessionId: 's-2' });
    const sessions = buildSessions([], [a, b, c]);
    expect(totalUnread(sessions, new Set())).toBe(3);
    expect(totalUnread(sessions, new Set([b.messageId]))).toBe(2);
  });
});

describe('summarize と detailOf', () => {
  it('日常の通知を 1 行にする', () => {
    expect(
      summarize(ev({ type: 'webhook', source: 'school', payload: { title: '図工の材料', due: '2026-11-17' } })),
    ).toBe('図工の材料');
    expect(
      summarize(ev({ type: 'webhook', source: 'delivery', payload: { carrier: '佐川急便', status: 'absent' } })),
    ).toBe('佐川急便 不在のお知らせ');
    expect(
      summarize(ev({ type: 'webhook', source: 'card', payload: { merchant: '携帯電話料金', amount: 18400 } })),
    ).toBe('携帯電話料金 18,400 円');
    expect(
      summarize(
        ev({ type: 'webhook', source: 'bills', payload: { kind: 'renewal', name: '動画配信', due: '2026-11-19' } }),
      ),
    ).toBe('動画配信の更新');
    expect(summarize(ev({ type: 'system', source: 'scheduler', payload: { kind: 'daily_check' } }))).toBe(
      '朝のチェック',
    );
  });

  it('形が違う通知や知らない送信元は「〇〇 からの通知」にする', () => {
    expect(summarize(ev({ type: 'webhook', source: 'school', payload: { body: 'タイトルなし' } }))).toBe(
      '学校連絡 からの通知',
    );
    expect(summarize(ev({ type: 'webhook', source: 'github', payload: {} }))).toBe('github からの通知');
  });

  it('2 行目に期限や持ち物を出す', () => {
    const e = ev({
      type: 'webhook',
      source: 'school',
      payload: { title: '遠足', due: '2026-11-17', items: ['水筒', '敷物'] },
    });
    expect(detailOf(e)).toBe('期限 11月17日（火） / 持ち物: 水筒、敷物');
  });
});
