import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoInboxRepository, type InboxRepository, type NewEventInput } from '../shared/inbox-repo.js';
import { DynamoMessageRepository, type MessageRepository } from '../shared/message-repo.js';
import { isValidSessionId, isValidUserId, type EventType, type WakeMessage } from '../shared/types.js';

/**
 * Event inbox の handler（記事: "A handler, usually an HTTP endpoint, that writes events to the list"）。
 *
 * ・素早く ACK する: inbox への書き込みと wake 信号の送信だけを行う
 * ・重い検証（プロンプトインジェクション判定など）は run の中で行う
 */
export interface HandlerDeps {
  inbox: InboxRepository;
  messages: MessageRepository;
  wake: (msg: WakeMessage, dedupId: string) => Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;
const SOURCE_PATTERN = /^[a-z0-9_.-]{1,32}$/;
const SOURCE_EVENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const EVENT_TYPES: EventType[] = ['user_message', 'webhook', 'system'];

export function buildHandler(deps: HandlerDeps) {
  return async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
      const userId = event.pathParameters?.userId;
      if (!isValidUserId(userId)) return json(400, { error: 'invalid userId' });

      const route = `${event.httpMethod} ${event.resource}`;
      switch (route) {
        case 'POST /users/{userId}/events':
          return await postEvent(deps, userId, event.body);
        case 'GET /users/{userId}/events': {
          const events = await deps.inbox.listRecentEvents(userId, parseLimit(event));
          return json(200, { events });
        }
        case 'GET /users/{userId}/messages': {
          const messages = await deps.messages.listRecent(userId, parseLimit(event));
          return json(200, { messages });
        }
        default:
          return json(404, { error: 'not found' });
      }
    } catch (err) {
      console.error('handler error', err);
      return json(500, { error: 'internal error' });
    }
  };
}

async function postEvent(deps: HandlerDeps, userId: string, rawBody: string | null): Promise<APIGatewayProxyResult> {
  if (!rawBody) return json(400, { error: 'body is required' });
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) return json(413, { error: 'body too large' });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json(400, { error: 'body must be JSON' });
  }
  const parsed = parseEventBody(userId, body);
  if ('error' in parsed) return json(400, { error: parsed.error });

  const { event, duplicate } = await deps.inbox.appendEvent(parsed);
  // 重複でも wake は送る（前回の受付が inbox 書き込み後・wake 前に落ちていた場合の取りこぼし防止）。
  // SQS FIFO の重複排除 ID = eventId なので、5 分以内の二重送信は SQS 側でまとめられる。
  await deps.wake({ userId, eventSk: event.sk }, event.eventId);
  return json(202, { eventId: event.eventId, status: event.status, duplicate });
}

export function parseEventBody(userId: string, body: Record<string, unknown>): NewEventInput | { error: string } {
  const sessionId = body.sessionId;
  if (sessionId !== undefined && !isValidSessionId(sessionId)) return { error: 'invalid sessionId' };

  // ユーザー発話のショートカット: { "text": "...", "sessionId"?: "..." }
  if (typeof body.text === 'string' && body.type === undefined) {
    const text = body.text.trim();
    if (!text) return { error: 'text is empty' };
    return { userId, type: 'user_message', source: 'user', sessionId, payload: { text } };
  }

  const type = body.type as EventType;
  if (!EVENT_TYPES.includes(type)) return { error: `type must be one of ${EVENT_TYPES.join(', ')}` };
  const source = body.source ?? (type === 'user_message' ? 'user' : undefined);
  if (typeof source !== 'string' || !SOURCE_PATTERN.test(source)) return { error: 'invalid source' };
  const sourceEventId = body.sourceEventId;
  if (sourceEventId !== undefined && (typeof sourceEventId !== 'string' || !SOURCE_EVENT_ID_PATTERN.test(sourceEventId))) {
    return { error: 'invalid sourceEventId' };
  }
  if (body.payload === undefined) return { error: 'payload is required' };
  return { userId, type, source, sourceEventId, sessionId, payload: body.payload };
}

function parseLimit(event: APIGatewayProxyEvent): number {
  const n = Number(event.queryStringParameters?.limit ?? 20);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 100) : 20;
}

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

// ---- Lambda エントリーポイント ----
let cached: ReturnType<typeof buildHandler> | undefined;

export const handler = (event: APIGatewayProxyEvent) => {
  if (!cached) {
    const sqs = new SQSClient({});
    const queueUrl = mustEnv('WAKE_QUEUE_URL');
    cached = buildHandler({
      inbox: new DynamoInboxRepository(mustEnv('INBOX_TABLE')),
      messages: new DynamoMessageRepository(mustEnv('MESSAGES_TABLE')),
      wake: async (msg, dedupId) => {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(msg),
            // inbox ごとに worker は 1 つ: 同じユーザーのメッセージは同時に 1 つしか処理されない
            MessageGroupId: msg.userId,
            MessageDeduplicationId: dedupId,
          }),
        );
      },
    });
  }
  return cached(event);
};

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
