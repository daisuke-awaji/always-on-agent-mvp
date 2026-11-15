import { delay, http, HttpResponse } from 'msw';
import { eventTypeSchema, SESSION_ID_PATTERN, USER_ID_PATTERN, type EventType } from '../api/schema';
import { appendEvent, listRecentEvents, listRecentMessages, type NewEventInput } from './db';
import { bad, base, parseLimit, readBody, readGuard, scenario } from './http';
import { memoryHandlers } from './memoryApi';
import { wake } from './simulator';
import { timerHandlers } from './timerApi';

/**
 * 実際の API（src/functions/handler.ts）と同じ URL・検証・ステータスコードを返すモック。
 *   POST /users/{userId}/events   → 202 { eventId, status, duplicate }
 *   GET  /users/{userId}/events   → 200 { events }   （新しい順、limit は 1〜100、既定 20）
 *   GET  /users/{userId}/messages → 200 { messages } （同上）
 * タイマーとメモリ（まだ実際の API にない）は timerApi.ts と memoryApi.ts。
 */
const SOURCE_PATTERN = /^[a-z0-9_.-]{1,32}$/;
const SOURCE_EVENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export function parseEventBody(userId: string, body: Record<string, unknown>): NewEventInput | { error: string } {
  const sessionId = body.sessionId;
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId))) {
    return { error: 'invalid sessionId' };
  }
  if (typeof body.text === 'string' && body.type === undefined) {
    const text = body.text.trim();
    if (!text) return { error: 'text is empty' };
    return { userId, type: 'user_message', source: 'user', sessionId, payload: { text } };
  }
  const type = eventTypeSchema.safeParse(body.type);
  if (!type.success) return { error: `type must be one of ${eventTypeSchema.options.join(', ')}` };
  const source = body.source ?? (type.data === 'user_message' ? 'user' : undefined);
  if (typeof source !== 'string' || !SOURCE_PATTERN.test(source)) return { error: 'invalid source' };
  const sourceEventId = body.sourceEventId;
  if (
    sourceEventId !== undefined &&
    (typeof sourceEventId !== 'string' || !SOURCE_EVENT_ID_PATTERN.test(sourceEventId))
  ) {
    return { error: 'invalid sourceEventId' };
  }
  if (body.payload === undefined) return { error: 'payload is required' };
  return { userId, type: type.data satisfies EventType, source, sourceEventId, sessionId, payload: body.payload };
}

export const handlers = [
  http.get(`${base}/events`, async ({ params, request }) => {
    const userId = String(params.userId);
    const err = await readGuard(userId);
    if (err) return err;
    return HttpResponse.json({ events: listRecentEvents(userId, parseLimit(request.url)) });
  }),

  http.get(`${base}/messages`, async ({ params, request }) => {
    const userId = String(params.userId);
    const err = await readGuard(userId);
    if (err) return err;
    return HttpResponse.json({ messages: listRecentMessages(userId, parseLimit(request.url)) });
  }),

  http.post(`${base}/events`, async ({ params, request }) => {
    // 受付は速く返す（記事の "ack fast"）。遅いシナリオでも読み込みほどは待たせない
    await delay(Math.min(scenario().latencyMs, 400));
    const userId = String(params.userId);
    if (!USER_ID_PATTERN.test(userId)) return bad(400, 'invalid userId');
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const parsed = parseEventBody(userId, body);
    if ('error' in parsed) return bad(400, parsed.error);

    const { event, duplicate } = appendEvent(parsed);
    // 重複でも wake は送る（実際の構成と同じ）
    wake(userId);
    return HttpResponse.json({ eventId: event.eventId, status: event.status, duplicate }, { status: 202 });
  }),
  ...timerHandlers,
  ...memoryHandlers,
];
