import type { AddressInfo } from 'node:net';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentServer } from '../src/agent/main.js';
import type { Sender } from '../src/agent/sender.js';
import { SessionStore } from '../src/agent/stores.js';
import { buildHandler } from '../src/functions/handler.js';
import { processUser, type WorkerDeps } from '../src/functions/worker-core.js';
import type { RunRequest, RunResult } from '../src/shared/types.js';
import { InMemoryInbox, InMemoryMessages, MemFileStore, readSession, scriptedConverse } from './fakes.js';

/**
 * handler → inbox → (wake) → worker → HTTP → agent server → memory / session / send
 * を 1 プロセスでつなぐ。AWS は使わず、モデルは台本どおりに応答するフェイク。
 */
const files = new MemFileStore();
const inbox = new InMemoryInbox();
const messages = new InMemoryMessages();
const sender: Sender = {
  send: async (m) => ({ messageId: (await messages.put(m)).messageId }),
};

// モデルのふるまい: 届いたイベントの数を数えて返信し、ユーザーの指示をメモリに書く
const { fn: converse, calls } = scriptedConverse((input) => {
  const last = input.messages!.at(-1)!;
  const hasToolResult = last.content!.some((c) => c.toolResult);
  if (hasToolResult) return { text: 'run 終了' };
  const text = last.content!.map((c) => c.text ?? '').join('');
  const count = Number(/count="(\d+)"/.exec(text)?.[1] ?? 0);
  const tools: { name: string; input: Record<string, unknown> }[] = [{ name: 'send_message', input: { text: `${count} 件受け取りました` } }];
  if (text.includes('深夜')) tools.push({ name: 'memory', input: { command: 'create', path: 'instructions.md', file_text: '- 深夜は連絡しない' } });
  return { tools };
});

const server = createAgentServer({ converse, files, sessions: new SessionStore(files), sender, modelId: 'fake' });
let baseUrl = '';
let wakes = 0;

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => { r(); })));

const handler = buildHandler({ inbox, messages, wake: async () => {
      wakes++;
    } });
let n = 0;
const workerDeps: WorkerDeps = {
  inbox,
  messages,
  invokeRun: async (req: RunRequest) => {
    const res = await fetch(`${baseUrl}/invocations`, { method: 'POST', body: JSON.stringify(req) });
    const body = (await res.json()) as RunResult & { error?: string };
    if (!res.ok) throw new Error(body.error);
    return body;
  },
  rewake: async () => {},
  newId: () => `run-${++n}`,
  newSessionId: () => `s-00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`,
  canStartRun: () => true,
  log: () => {},
};
const opts = { owner: 'w', leaseMs: 60_000, maxRounds: 5, maxAttempts: 3, recentMessages: 5 };

const post = (body: unknown) =>
  handler({
    httpMethod: 'POST',
    resource: '/users/{userId}/events',
    pathParameters: { userId: 'alice' },
    body: JSON.stringify(body),
  } as unknown as APIGatewayProxyEvent);

describe('end-to-end (in-process)', () => {
  it('ping は Healthy', async () => {
    expect(await (await fetch(`${baseUrl}/ping`)).json()).toMatchObject({ status: 'Healthy' });
  });

  it('連投された 2 件を 1 回の run で処理し、1 通だけ返信する', async () => {
    await post({ text: 'こんにちは' });
    await post({ text: '深夜は連絡しないでください' });
    expect(wakes).toBe(2);
    const res = await processUser('alice', workerDeps, opts);
    expect(res.status === 'ok' && res.runs).toHaveLength(1);
    expect(messages.items.map((m) => m.text)).toEqual(['2 件受け取りました']);
    expect(files.files.get('memory/alice/instructions.md')).toBe('- 深夜は連絡しない');
    expect((await inbox.listRecentEvents('alice', 10)).every((e) => e.status === 'done')).toBe(true);
  });

  it('返信（sessionId 付き）は同じ session を再開し、指示が文脈に入る', async () => {
    const sessionId = messages.items[0].sessionId;
    await post({ text: 'ありがとう', sessionId });
    await processUser('alice', workerDeps, opts);
    const lastCall = calls.at(-2)!; // 最後の run の 1 ターン目
    expect(lastCall.system![2].text).toContain('以前の session の続き');
    expect(lastCall.system![2].text).toContain('深夜は連絡しない');
    expect(lastCall.system![2].text).toContain('2 件受け取りました'); // 直近の送信
    const saved = readSession(files, 'alice', sessionId);
    expect(saved.runs).toBe(2);
  });

  it('agent が 400 を返す不正なリクエストは run の失敗として扱われる', async () => {
    const res = await fetch(`${baseUrl}/invocations`, { method: 'POST', body: JSON.stringify({ runId: 'x', userId: 'alice', sessionId: 'bad', events: [] }) });
    expect(res.status).toBe(400);
  });
});
