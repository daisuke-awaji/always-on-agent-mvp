import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAgentServer } from '../src/agent/main.js';
import type { Sender } from '../src/agent/sender.js';
import { SessionStore } from '../src/agent/stores.js';
import type { RunRequest } from '../src/shared/types.js';
import { MemFileStore, scriptedConverse } from './fakes.js';

const files = new MemFileStore();
const sender: Sender = { send: async () => ({ messageId: 'm1' }) };
const server = createAgentServer({
  converse: scriptedConverse([{ text: '了解' }]).fn,
  files,
  sessions: new SessionStore(files),
  sender,
  modelId: 'fake',
});
let baseUrl = '';

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(
  () =>
    new Promise<void>((r) =>
      server.close(() => {
        r();
      }),
    ),
);
afterEach(() => {
  vi.restoreAllMocks();
});

const runRequest: RunRequest = {
  runId: 'run-1',
  userId: 'alice',
  sessionId: 's-11111111-1111-1111-1111-111111111111',
  events: [
    {
      eventId: 'e1',
      type: 'user_message',
      source: 'user',
      receivedAt: '2026-11-15T00:00:00Z',
      payload: { text: 'hi' },
    },
  ],
  recentMessages: [],
};

describe('agent server', () => {
  it.each([
    ['null', 400],
    ['[]', 400],
    ['{}', 400],
  ])('POST /invocations の不正な本文 %s → %d', async (body, status) => {
    const res = await fetch(`${baseUrl}/invocations`, { method: 'POST', body });
    expect(res.status).toBe(status);
  });

  it('応答の送信自体に失敗しても、未処理の reject にせず接続を閉じ、サーバーは動き続ける', async () => {
    // 200 のヘッダーを書いた後に本文の直列化で失敗させる。catch 側の 500 送信も
    // ERR_HTTP_HEADERS_SENT で失敗するので、handle() の Promise が reject される経路になる
    const stringify = JSON.stringify.bind(JSON);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(JSON, 'stringify').mockImplementation(
      (value: unknown, replacer?: (string | number)[] | null, space?: string | number) => {
        if (typeof value === 'object' && value !== null && 'usage' in value && 'outcome' in value) {
          throw new Error('serialize failed');
        }
        return stringify(value, replacer, space);
      },
    );

    await expect(
      fetch(`${baseUrl}/invocations`, { method: 'POST', body: stringify(runRequest) }).then((r) => r.text()),
    ).rejects.toThrow();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('failed to send response'));

    vi.restoreAllMocks();
    const ping = await fetch(`${baseUrl}/ping`);
    expect(ping.status).toBe(200);
  });
});
