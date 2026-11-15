import type { APIGatewayProxyEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { buildHandler, parseEventBody } from '../src/functions/handler.js';
import type { WakeMessage } from '../src/shared/types.js';
import { InMemoryInbox, InMemoryMessages } from './fakes.js';

function setup() {
  const inbox = new InMemoryInbox();
  const messages = new InMemoryMessages();
  const wakes: { msg: WakeMessage; dedupId: string }[] = [];
  const handler = buildHandler({ inbox, messages, wake: async (msg, dedupId) => void wakes.push({ msg, dedupId }) });
  return { inbox, messages, wakes, handler };
}

const req = (method: string, resource: string, userId: string, body?: unknown, qs?: Record<string, string>) =>
  ({
    httpMethod: method,
    resource,
    pathParameters: { userId },
    body: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body),
    queryStringParameters: qs ?? null,
  }) as unknown as APIGatewayProxyEvent;

const SID = 's-11111111-1111-1111-1111-111111111111';

describe('parseEventBody', () => {
  it('text だけならユーザー発話として扱う', () => {
    expect(parseEventBody('u', { text: ' こんにちは ' })).toEqual({
      userId: 'u',
      type: 'user_message',
      source: 'user',
      sessionId: undefined,
      payload: { text: 'こんにちは' },
    });
  });
  it.each([
    [{ text: '' }, 'text is empty'],
    [{ type: 'unknown', payload: {} }, 'type must be one of'],
    [{ type: 'webhook', payload: {} }, 'invalid source'],
    [{ type: 'webhook', source: 'GitHub!', payload: {} }, 'invalid source'],
    [{ type: 'webhook', source: 'github', sourceEventId: 'a b', payload: {} }, 'invalid sourceEventId'],
    [{ type: 'webhook', source: 'github' }, 'payload is required'],
    [{ text: 'hi', sessionId: '../../etc' }, 'invalid sessionId'],
  ])('不正な入力を拒否する %j', (body, message) => {
    const r = parseEventBody('u', body as Record<string, unknown>);
    expect('error' in r && r.error).toContain(message);
  });
});

describe('handler', () => {
  it('POST events: inbox に書き、userId をグループにして wake を送り、202 を返す', async () => {
    const { inbox, wakes, handler } = setup();
    const res = await handler(req('POST', '/users/{userId}/events', 'alice', { text: 'hi', sessionId: SID }));
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ status: 'pending', duplicate: false });
    expect(wakes).toEqual([{ msg: { userId: 'alice', eventSk: expect.stringMatching(/^EVT#/) }, dedupId: body.eventId }]);
    expect((await inbox.listOpenEvents('alice'))[0]).toMatchObject({ sessionId: SID, type: 'user_message' });
  });

  it('同じ sourceEventId の再送は重複として扱い、取りこぼし防止のため wake は送り直す', async () => {
    const { inbox, wakes, handler } = setup();
    const body = { type: 'webhook', source: 'github', sourceEventId: 'delivery-1', payload: { action: 'opened' } };
    const r1 = JSON.parse((await handler(req('POST', '/users/{userId}/events', 'alice', body))).body);
    const r2 = JSON.parse((await handler(req('POST', '/users/{userId}/events', 'alice', body))).body);
    expect(r2).toMatchObject({ duplicate: true, eventId: r1.eventId });
    expect(await inbox.listOpenEvents('alice')).toHaveLength(1);
    expect(wakes.map((w) => w.dedupId)).toEqual([r1.eventId, r1.eventId]);
  });

  it('GET messages / events', async () => {
    const { messages, handler } = setup();
    await messages.put({ userId: 'alice', sessionId: SID, runId: 'r', text: 'hello', importance: 'normal' });
    const res = await handler(req('GET', '/users/{userId}/messages', 'alice', undefined, { limit: '5' }));
    expect(JSON.parse(res.body).messages[0]).toMatchObject({ text: 'hello' });
    await handler(req('POST', '/users/{userId}/events', 'alice', { text: 'x' }));
    const ev = await handler(req('GET', '/users/{userId}/events', 'alice'));
    expect(JSON.parse(ev.body).events).toHaveLength(1);
  });

  it.each([
    [req('POST', '/users/{userId}/events', 'a/b', { text: 'x' }), 400],
    [req('POST', '/users/{userId}/events', 'alice', 'not-json'), 400],
    // JSON としては正しいがオブジェクトではない本文
    [req('POST', '/users/{userId}/events', 'alice', 'null'), 400],
    [req('POST', '/users/{userId}/events', 'alice', '[]'), 400],
    [req('POST', '/users/{userId}/events', 'alice', '"hello"'), 400],
    [req('POST', '/users/{userId}/events', 'alice', '42'), 400],
    [req('POST', '/users/{userId}/events', 'alice', 'x'.repeat(70 * 1024)), 413],
    [req('POST', '/users/{userId}/events', 'alice'), 400],
    [req('DELETE', '/users/{userId}/events', 'alice'), 404],
  ])('不正なリクエスト → %#', async (event, status) => {
    const { handler, wakes } = setup();
    expect((await handler(event)).statusCode).toBe(status);
    expect(wakes).toHaveLength(0);
  });
});
