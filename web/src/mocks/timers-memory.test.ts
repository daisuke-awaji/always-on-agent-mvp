import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cancelTimer,
  createTimer,
  deleteMemoryFile,
  listMemory,
  listTimers,
  readMemoryFile,
  updateTimer,
  writeMemoryFile,
} from '../api/client';
import type { InboxEvent } from '../api/schema';
import { removeIndexLinks } from '../ui/memory';
import { dueLabel, expressionOf, nextOccurrence, recurrenceLabel } from '../ui/timers';
import { parseWhen, subjectOf, think } from './brain';
import { getState, resetState } from './db';
import { handlers } from './handlers';
import { applyEffects } from './records';
import { seedFor } from './scenarios';
import { fireNow, tick } from './simulator';

const server = setupServer(...handlers);
beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});
afterAll(() => {
  server.close();
});

const inDays = (d: number, h = 9) => {
  const x = new Date();
  x.setDate(x.getDate() + d);
  x.setHours(h, 0, 0, 0);
  return x.toISOString();
};

describe('タイマーの時刻', () => {
  // 2026-11-16（月）10:00
  const mon10 = new Date(2026, 10, 16, 10, 0);

  it('毎日: 今日の時刻を過ぎていれば明日', () => {
    expect(nextOccurrence({ freq: 'daily', time: '07:00' }, mon10)).toEqual(new Date(2026, 10, 17, 7, 0));
    expect(nextOccurrence({ freq: 'daily', time: '19:30' }, mon10)).toEqual(new Date(2026, 10, 16, 19, 30));
  });

  it('毎週: 次の曜日。同じ曜日で時刻を過ぎていれば翌週', () => {
    expect(nextOccurrence({ freq: 'weekly', time: '20:00', weekdays: [5] }, mon10)).toEqual(
      new Date(2026, 10, 20, 20, 0),
    );
    expect(nextOccurrence({ freq: 'weekly', time: '09:00', weekdays: [1] }, mon10)).toEqual(
      new Date(2026, 10, 23, 9, 0),
    );
  });

  it('毎月: 次のその日（月をまたぐ）', () => {
    expect(nextOccurrence({ freq: 'monthly', time: '09:00', dayOfMonth: 25 }, mon10)).toEqual(
      new Date(2026, 10, 25, 9, 0),
    );
    expect(nextOccurrence({ freq: 'monthly', time: '09:00', dayOfMonth: 1 }, mon10)).toEqual(
      new Date(2026, 11, 1, 9, 0),
    );
  });

  it('EventBridge Scheduler の式', () => {
    expect(expressionOf('schedule', '', { freq: 'daily', time: '07:00' })).toBe('cron(0 7 * * ? *)');
    expect(expressionOf('schedule', '', { freq: 'weekly', time: '20:30', weekdays: [1, 5] })).toBe(
      'cron(30 20 ? * MON,FRI *)',
    );
    expect(expressionOf('schedule', '', { freq: 'monthly', time: '09:00', dayOfMonth: 25 })).toBe('cron(0 9 25 * ? *)');
    expect(expressionOf('followup', new Date(2026, 11, 1, 9, 0).toISOString())).toBe('at(2026-12-01T09:00:00)');
  });

  it('繰り返しの言い方', () => {
    expect(recurrenceLabel({ freq: 'daily', time: '07:00' })).toBe('毎日 7:00');
    expect(recurrenceLabel({ freq: 'weekly', time: '20:00', weekdays: [5] })).toBe('毎週 金曜 20:00');
    expect(recurrenceLabel({ freq: 'weekly', time: '07:30', weekdays: [1, 2, 3, 4, 5] })).toBe('平日 7:30');
    expect(recurrenceLabel({ freq: 'weekly', time: '08:00', weekdays: [0, 3, 1] })).toBe('毎週 月・水・日 8:00');
    expect(recurrenceLabel({ freq: 'monthly', time: '09:00', dayOfMonth: 25 })).toBe('毎月 25日 9:00');
  });

  it('日時の言い方: 括弧のあとに空白を入れない', () => {
    expect(dueLabel(new Date(2026, 10, 17, 7, 0).toISOString(), mon10)).toBe('明日 7:00');
    expect(dueLabel(new Date(2026, 10, 20, 19, 0).toISOString(), mon10)).toBe('11月20日（金）19:00');
  });
});

describe('タイマーの API', () => {
  beforeEach(() => {
    resetState('empty');
  });

  it('繰り返しを作ると 201、作った人は user、次の回と式が決まる', async () => {
    const t = await createTimer('alice', {
      kind: 'schedule',
      title: '週末の予定のまとめ',
      recurrence: { freq: 'weekly', time: '20:00', weekdays: [5] },
    });
    expect(t).toMatchObject({ kind: 'schedule', createdBy: 'user', status: 'active', timezone: 'Asia/Tokyo' });
    expect(t.expression).toBe('cron(0 20 ? * FRI *)');
    expect(new Date(t.dueAt).getDay()).toBe(5);
    expect(Date.parse(t.dueAt)).toBeGreaterThan(Date.now());
    expect(await listTimers('alice')).toHaveLength(1);
  });

  it.each([
    [{ kind: 'other', title: 'x' }, 'kind must be followup or schedule'],
    [{ kind: 'followup', title: ' ', dueAt: inDays(1) }, 'title is required'],
    [{ kind: 'followup', title: 'x'.repeat(81), dueAt: inDays(1) }, 'title must be <= 80 characters'],
    [{ kind: 'followup', title: 'x' }, 'dueAt is required for followup'],
    [{ kind: 'followup', title: 'x', dueAt: inDays(-1) }, 'dueAt must be in the future'],
    [{ kind: 'followup', title: 'x', dueAt: inDays(400) }, 'dueAt must be within 366 days'],
    [{ kind: 'schedule', title: 'x' }, 'recurrence is required for schedule'],
    [
      { kind: 'schedule', title: 'x', recurrence: { freq: 'weekly', time: '07:00' } },
      'recurrence.weekdays is required for weekly',
    ],
    [
      { kind: 'schedule', title: 'x', recurrence: { freq: 'monthly', time: '07:00', dayOfMonth: 31 } },
      'recurrence.dayOfMonth must be 1-28',
    ],
    [{ kind: 'schedule', title: 'x', recurrence: { freq: 'daily', time: '25:00' } }, 'recurrence.time must be HH:MM'],
  ])('検証エラーは 400（%j）', async (body, error) => {
    await expect(createTimer('alice', body as never)).rejects.toMatchObject({ status: 400, message: error });
  });

  it('時刻を変えると、次の回と式も変わる。種類は変えられない', async () => {
    const t = await createTimer('alice', {
      kind: 'schedule',
      title: '朝のチェック',
      recurrence: { freq: 'daily', time: '07:00' },
    });
    const u = await updateTimer('alice', t.timerId, { recurrence: { freq: 'daily', time: '06:30' } });
    expect(u.expression).toBe('cron(30 6 * * ? *)');
    expect(new Date(u.dueAt).getMinutes()).toBe(30);
    await expect(updateTimer('alice', t.timerId, { dueAt: inDays(1) })).rejects.toMatchObject({ status: 400 });
    await expect(updateTimer('alice', t.timerId, { kind: 'followup' } as never)).rejects.toMatchObject({
      message: 'kind cannot be changed',
    });
  });

  it('取り消すと cancelled で残り、もう変えられない（409）。知らない ID は 404', async () => {
    const t = await createTimer('alice', { kind: 'followup', title: '長靴が届いたか', dueAt: inDays(1) });
    expect(await cancelTimer('alice', t.timerId)).toMatchObject({ status: 'cancelled' });
    await expect(cancelTimer('alice', t.timerId)).rejects.toMatchObject({ status: 409 });
    await expect(updateTimer('alice', t.timerId, { title: 'y' })).rejects.toMatchObject({ status: 409 });
    await expect(cancelTimer('alice', 'nope')).rejects.toMatchObject({ status: 404 });
    expect((await listTimers('alice'))[0]).toMatchObject({ status: 'cancelled' });
  });

  it('一覧は動いているものが近い順、そのあとに終わったもの', async () => {
    const later = await createTimer('alice', { kind: 'followup', title: 'b', dueAt: inDays(3) });
    const sooner = await createTimer('alice', { kind: 'followup', title: 'a', dueAt: inDays(1) });
    const gone = await createTimer('alice', { kind: 'followup', title: 'c', dueAt: inDays(2) });
    await cancelTimer('alice', gone.timerId);
    expect((await listTimers('alice')).map((t) => t.timerId)).toEqual([sooner.timerId, later.timerId, gone.timerId]);
  });
});

describe('スケジューラ（EventBridge Scheduler の代わり）', () => {
  beforeEach(() => {
    resetState('empty');
  });

  it('follow-up は時刻が来たら done になり、作った会話の続きとして inbox に入る', async () => {
    const t = await createTimer('alice', { kind: 'followup', title: '車検のこと', dueAt: inDays(1) });
    // エージェントが会話の中で作った follow-up にする
    Object.assign(getState().timers.at(0) ?? {}, { sessionId: 's-00000000-0000-4000-8000-000000000001' });
    expect(tick(new Date())).toEqual([]);
    const users = tick(new Date(Date.parse(t.dueAt) + 1000));
    expect(users).toEqual(['alice']);
    expect(getState().timers[0]).toMatchObject({ status: 'done' });
    const e = getState().events.at(-1);
    expect(e).toMatchObject({
      type: 'system',
      source: 'scheduler',
      sessionId: 's-00000000-0000-4000-8000-000000000001',
      sourceEventId: `timer:${t.timerId}:${t.dueAt}`,
      payload: { kind: 'followup', title: '車検のこと' },
    });
  });

  it('schedule は次の回に進む。閉じていたあいだに何回分も過ぎても 1 回だけ動く', async () => {
    const t = await createTimer('alice', {
      kind: 'schedule',
      title: '朝のチェック',
      recurrence: { freq: 'daily', time: '07:00' },
    });
    const threeDaysLater = new Date(Date.parse(t.dueAt) + 3 * 86_400_000 + 60_000);
    tick(threeDaysLater);
    expect(getState().events).toHaveLength(1);
    const next = getState().timers.at(0);
    expect(next?.status).toBe('active');
    expect(Date.parse(next?.dueAt ?? '')).toBeGreaterThan(threeDaysLater.getTime());
    expect(next?.lastFiredAt).toBe(threeDaysLater.toISOString());
  });

  it('「今すぐ動かす」は schedule の次の回をずらさない', async () => {
    const t = await createTimer('alice', {
      kind: 'schedule',
      title: '週末のまとめ',
      recurrence: { freq: 'weekly', time: '20:00', weekdays: [5] },
    });
    expect(fireNow(t.timerId)).toBe(true);
    expect(getState().timers[0]).toMatchObject({ status: 'active', dueAt: t.dueAt });
    expect(getState().events).toHaveLength(1);
  });
});

describe('メモリの API', () => {
  beforeEach(() => {
    resetState('standard');
  });

  it('一覧には、毎回読み込むファイルとメモ・タスクがある', async () => {
    const { files, limits } = await listMemory('alice');
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining(['instructions.md', 'notes/index.md', 'tasks/index.md', 'notes/swimming.md']),
    );
    expect(limits).toEqual({ maxFileBytes: 32 * 1024, maxFiles: 200 });
  });

  it('読んだ版で書くと保存でき、版が進んで updatedBy は user になる', async () => {
    const f = await readMemoryFile('alice', 'instructions.md');
    const saved = await writeMemoryFile('alice', 'instructions.md', `${f.content}- 週末は静かに\n`, f.version);
    expect(saved.updatedBy).toBe('user');
    expect(saved.version).not.toBe(f.version);
    expect((await readMemoryFile('alice', 'instructions.md')).content).toContain('週末は静かに');
  });

  it('あいだにエージェントが書き換えていたら 409 で、上書きしない', async () => {
    const f = await readMemoryFile('alice', 'instructions.md');
    applyEffects(
      getState(),
      'alice',
      's-x',
      { memory: [{ path: 'instructions.md', append: '- run が足した行' }], timers: [] },
      new Date(),
    );
    await expect(writeMemoryFile('alice', 'instructions.md', 'まるごと置き換え', f.version)).rejects.toMatchObject({
      status: 409,
    });
    expect((await readMemoryFile('alice', 'instructions.md')).content).toContain('run が足した行');
  });

  it('大きすぎるファイル（32 KB 超）は 413、変なパスは 400、ないファイルは 404', async () => {
    const f = await readMemoryFile('alice', 'notes/family.md');
    await expect(writeMemoryFile('alice', 'notes/family.md', 'あ'.repeat(11_000), f.version)).rejects.toMatchObject({
      status: 413,
    });
    await expect(readMemoryFile('alice', 'notes/.secret')).rejects.toMatchObject({ status: 400 });
    await expect(readMemoryFile('alice', 'notes/nothing.md')).rejects.toMatchObject({ status: 404 });
    await expect(writeMemoryFile('alice', 'notes/new.md', 'x', 'v1')).rejects.toMatchObject({ status: 404 });
  });

  it('古いメモを消すと、index.md の行も消える。毎回読み込むファイルは消せない', async () => {
    const f = await readMemoryFile('alice', 'notes/swimming.md');
    await deleteMemoryFile('alice', 'notes/swimming.md', f.version);
    await expect(readMemoryFile('alice', 'notes/swimming.md')).rejects.toMatchObject({ status: 404 });
    const index = await readMemoryFile('alice', 'notes/index.md');
    expect(index.content).not.toContain('swimming.md');
    expect(index.content).toContain('family.md');

    const ins = await readMemoryFile('alice', 'instructions.md');
    await expect(deleteMemoryFile('alice', 'instructions.md', ins.version)).rejects.toMatchObject({ status: 400 });
  });

  it('消すときも版が違えば 409', async () => {
    await expect(deleteMemoryFile('alice', 'notes/family.md', 'v999')).rejects.toMatchObject({ status: 409 });
  });

  it('index.md から消すのは、そのファイルを指す箇条書きの行だけ', () => {
    const index = '# メモ\n\n- [家族](family.md): …\n- [水泳](swimming.md): …\nswimming.md の話（本文）\n';
    expect(removeIndexLinks(index, 'swimming.md')).toBe('# メモ\n\n- [家族](family.md): …\nswimming.md の話（本文）\n');
  });
});

describe('モックのエージェントがタイマーとメモリを書く', () => {
  const ref = new Date(2026, 10, 16, 10, 0); // 11月16日（月）10:00
  const at = ref.toISOString();
  const base = { userId: 'alice', status: 'processing' as const, attempts: 1, receivedAt: at, updatedAt: at, sk: '' };
  const user = (text: string): InboxEvent => ({
    ...base,
    eventId: 'u',
    type: 'user_message',
    source: 'user',
    payload: { text },
  });

  it('「思い出させて」は follow-up と tasks/ のファイルを作り、返事で時刻を言う', () => {
    const out = think([user('車検が1月なので、1か月前になったら思い出させてください。')]);
    expect(out.effects.timers).toEqual([
      expect.objectContaining({
        kind: 'followup',
        title: '車検のこと',
        dueAt: new Date(2026, 11, 1, 9, 0).toISOString(),
      }),
    ]);
    expect(out.effects.memory.map((m) => m.path)).toEqual(['tasks/reminder-20261201-0900.md', 'tasks/index.md']);
    expect(out.messages[0]?.text).toContain('12月1日（火）9:00にお知らせするタイマーを設定');
  });

  it.each([
    ['5分後に思い出させて', new Date(2026, 10, 16, 10, 5)],
    ['2時間後にリマインドして', new Date(2026, 10, 16, 12, 0)],
    ['明日の7時に思い出させて', new Date(2026, 10, 17, 7, 0)],
    ['3日後に思い出させて', new Date(2026, 10, 19, 9, 0)],
    ['12月24日に思い出させて', new Date(2026, 11, 24, 9, 0)],
    ['2月に思い出させて', new Date(2027, 1, 1, 9, 0)],
    ['いつか思い出させて', new Date(2026, 10, 19, 9, 0)],
  ])('いつ: %s', (text, when) => {
    expect(parseWhen(text, ref)).toEqual(when);
  });

  it.each([
    ['ありがとう。車検が1月なので、1か月前になったら思い出させてください。', '車検'],
    ['2分後に、洗濯物を取り込むよう思い出させて', '洗濯物'],
    ['明日の7時にゴミ出しを思い出させて', 'ゴミ出し'],
  ])('主題: %s', (text, subject) => {
    expect(subjectOf(text)).toBe(subject);
  });

  it('「〜だけ知らせて」は instructions.md に足す', () => {
    const out = think([user('配送は不在のときだけ知らせてください')]);
    expect(out.effects.memory).toEqual([
      { path: 'instructions.md', header: '# あなたからの指示\n\n', append: '- 配送は不在のときだけ知らせてください' },
    ]);
  });

  it('5 日後が期限の支払いは、前の日の 19 時にもう一度知らせる follow-up を作る。2 日以内なら作らない', () => {
    const bill = (due: string): InboxEvent => ({
      ...base,
      eventId: due,
      type: 'webhook',
      source: 'bills',
      payload: { kind: 'bill', name: '水道料金', amount: 6820, due, method: 'コンビニ払い' },
    });
    const out = think([bill('2026-11-21')]);
    expect(out.effects.timers).toEqual([
      {
        kind: 'followup',
        title: '水道料金の支払い期限（11月21日（土））',
        note: '6,820 円、コンビニ払い',
        dueAt: new Date(2026, 10, 20, 19, 0).toISOString(),
      },
    ]);
    expect(out.messages[0]?.text).toContain('前の日の夜にもう一度お知らせします');
    expect(think([bill('2026-11-17')]).effects.timers).toEqual([]);
  });

  it('タイマーで起きたら: follow-up はリマインド、朝のチェックは黙っている', () => {
    const fired = (payload: unknown): InboxEvent => ({
      ...base,
      eventId: 'f',
      type: 'system',
      source: 'scheduler',
      payload,
    });
    expect(
      think([fired({ kind: 'followup', title: '水道料金の支払い期限は明日', note: '6,820 円' })]).messages,
    ).toEqual([{ text: 'リマインドです。水道料金の支払い期限は明日。\n6,820 円', importance: 'normal' }]);
    expect(think([fired({ kind: 'schedule', title: '朝のチェック' })]).messages).toEqual([]);
  });
});

describe('デモの履歴', () => {
  it('繰り返しと 1 回だけの両方、終わったものがあり、動いている follow-up はすべて先の時刻', () => {
    const now = new Date();
    const seed = seedFor('standard', now);
    const active = seed.timers.filter((t) => t.status === 'active');
    expect(active.some((t) => t.kind === 'schedule' && t.createdBy === 'agent')).toBe(true);
    expect(active.some((t) => t.kind === 'schedule' && t.createdBy === 'user')).toBe(true);
    expect(active.filter((t) => t.kind === 'followup').length).toBeGreaterThanOrEqual(2);
    for (const t of active) expect(Date.parse(t.dueAt)).toBeGreaterThan(now.getTime());
    expect(seed.timers.some((t) => t.status === 'done')).toBe(true);
    expect(seed.timers.some((t) => t.status === 'cancelled')).toBe(true);
    expect(Object.keys(seed.memory.alice ?? {})).toEqual(
      expect.arrayContaining(['instructions.md', 'notes/index.md', 'tasks/index.md']),
    );
  });

  it('タイマーで起きた run は、scheduler の system イベントとして履歴に残る', () => {
    const seed = seedFor('standard', new Date());
    const fired = seed.events.filter((e) => e.source === 'scheduler');
    expect(fired.map((e) => (e.payload as { title: string }).title)).toEqual(['朝のチェック', '遠足の参加票の確認']);
  });
});
