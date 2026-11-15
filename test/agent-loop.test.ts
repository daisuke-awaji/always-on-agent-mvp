import { describe, expect, it } from 'vitest';
import { AGENT_LIMITS, runAgent, type AgentDeps } from '../src/agent/loop.js';
import type { OutgoingMessage, Sender } from '../src/agent/sender.js';
import { SessionStore } from '../src/agent/stores.js';
import type { RunRequest } from '../src/shared/types.js';
import { MemFileStore, readSession, scriptedConverse, type ScriptStep } from './fakes.js';

const SID = 's-11111111-1111-1111-1111-111111111111';

function setup(steps: ScriptStep[] | Parameters<typeof scriptedConverse>[0]) {
  const files = new MemFileStore();
  const sent: OutgoingMessage[] = [];
  const sender: Sender = { send: async (m) => (sent.push(m), { messageId: `m${sent.length}` }) };
  const { fn, calls } = scriptedConverse(steps);
  const deps: AgentDeps = {
    converse: fn,
    files,
    sessions: new SessionStore(files),
    sender,
    modelId: 'test-model',
    now: () => new Date('2026-11-15T00:00:00Z'),
  };
  return { files, sent, calls, deps };
}

const req = (over: Partial<RunRequest> = {}): RunRequest => ({
  runId: 'run-1',
  userId: 'alice',
  sessionId: SID,
  events: [
    {
      eventId: 'e1',
      type: 'user_message',
      source: 'user',
      receivedAt: '2026-11-15T00:00:00Z',
      payload: { text: '私は調達担当です' },
    },
  ],
  recentMessages: [],
  ...over,
});

describe('runAgent', () => {
  it('メモリに書き、メッセージを送り、session を保存する', async () => {
    const { files, sent, calls, deps } = setup([
      {
        tools: [
          { name: 'memory', input: { command: 'create', path: 'notes/index.md', file_text: '- role: 調達担当' } },
        ],
      },
      { tools: [{ name: 'send_message', input: { text: '了解しました。' } }] },
      { text: '役割を記録し、返信した。' },
    ]);
    const result = await runAgent(req(), deps);
    expect(result).toMatchObject({
      runId: 'run-1',
      outcome: 'sent',
      messagesSent: 1,
      turns: 3,
      stopReason: 'end_turn',
    });
    expect(result.usage).toMatchObject({ inputTokens: 300, cacheReadInputTokens: 150 });
    expect(files.files.get('memory/alice/notes/index.md')).toBe('- role: 調達担当');
    expect(sent[0]).toMatchObject({
      userId: 'alice',
      sessionId: SID,
      runId: 'run-1',
      text: '了解しました。',
      importance: 'normal',
    });

    // 静的プロンプト → cachePoint → 動的文脈 の順。イベントは <events> で囲む
    const first = calls[0];
    expect(first.system![1]).toEqual({ cachePoint: { type: 'default' } });
    expect(first.system![2].text).toContain('新しい session');
    expect(JSON.stringify(first.messages)).toContain('<events count=\\"1\\">');
    // 最後のメッセージにキャッシュポイント
    expect(first.messages!.at(-1)!.content!.at(-1)).toEqual({ cachePoint: { type: 'default' } });

    const saved = readSession(files, 'alice', SID);
    expect(saved.runs).toBe(1);
    expect(saved.messages).toHaveLength(6); // user, (asst, toolResult) x2, asst
    expect(JSON.stringify(saved.messages)).not.toContain('cachePoint');
  });

  it('2 回目の run では session を再開し、メモリが文脈に入る', async () => {
    const { files, calls, deps } = setup([{ text: 'ok' }, { text: 'ok2' }]);
    await files.put('memory/alice/instructions.md', '深夜は連絡しない');
    await runAgent(req(), deps);
    await runAgent(
      req({
        runId: 'run-2',
        events: [{ eventId: 'e2', type: 'webhook', source: 'github', receivedAt: 'x', payload: { a: 1 } }],
      }),
      deps,
    );
    const second = calls[1];
    expect(second.system![2].text).toContain('以前の session の続き');
    expect(second.system![2].text).toContain('深夜は連絡しない');
    expect(second.messages).toHaveLength(3); // user(e1), asst, user(e2)
    expect(readSession(files, 'alice', SID).runs).toBe(2);
  });

  it('送らない判断もできる（silent）', async () => {
    const { sent, deps } = setup([{ text: '重要でないので送らない。' }]);
    expect((await runAgent(req(), deps)).outcome).toBe('silent');
    expect(sent).toHaveLength(0);
  });

  it('1 run あたりの送信上限を超えるとツールエラーを返す', async () => {
    const send = (t: string) => ({ name: 'send_message', input: { text: t } });
    const { sent, calls, deps } = setup([{ tools: [send('1'), send('2'), send('3'), send('4')] }, { text: 'done' }]);
    const result = await runAgent(req(), deps);
    expect(result.messagesSent).toBe(AGENT_LIMITS.maxSendsPerRun);
    expect(sent).toHaveLength(3);
    const toolResults = calls[1].messages!.at(-1)!.content!.filter((c) => c.toolResult);
    expect(toolResults.at(-1)!.toolResult!.status).toBe('error');
  });

  it('不正なメモリ操作や未知のツールはエラーとしてモデルに返し、run は続く', async () => {
    const { calls, deps } = setup([
      {
        tools: [
          { name: 'memory', input: { command: 'create', path: '../../etc/passwd', file_text: 'x' } },
          { name: 'shell', input: {} },
        ],
      },
      { text: 'done' },
    ]);
    await runAgent(req(), deps);
    const results = calls[1]
      .messages!.at(-1)!
      .content!.filter((c) => c.toolResult)
      .map((c) => c.toolResult!);
    expect(results.map((r) => r.status)).toEqual(['error', 'error']);
    expect(results[1].content![0].text).toContain('unknown tool');
  });

  it('ターン上限で打ち切っても、次の run が再開できる形で保存する', async () => {
    const { files, deps } = setup(() => ({ tools: [{ name: 'memory', input: { command: 'view', path: '' } }] }));
    const result = await runAgent(req(), deps);
    expect(result).toMatchObject({ turns: AGENT_LIMITS.maxTurns, stopReason: 'max_turns' });
    const saved = readSession(files, 'alice', SID);
    expect(saved.messages.at(-1)?.role).toBe('user'); // toolResult で終わる → 次回は appendUserContent でまとめる
  });
});
