import type { z } from 'zod';
import {
  errorResponseSchema,
  listEventsResponseSchema,
  listMessagesResponseSchema,
  postEventResponseSchema,
  type InboxEvent,
  type PostEventBody,
  type PostEventResponse,
  type StoredMessage,
} from './schema';

/**
 * API の呼び出し口。今はモック（MSW）が `<base>/mock-api` で受ける。
 * 実際の API につなぐときは VITE_API_BASE を API Gateway の URL にする
 * （ただし実際の API は IAM 認証なので、ブラウザから呼ぶには Cognito などの認証を足す必要がある）。
 */
export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? `${import.meta.env.BASE_URL}mock-api`;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  // 相対パス（モック）でも絶対 URL（実際の API）でも動くよう、ページの URL を基準に組み立てる
  const url = new URL(`${API_BASE}${path}`, globalThis.location.href);
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json' } });
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const parsed = errorResponseSchema.safeParse(body);
    throw new ApiError(res.status, parsed.success ? parsed.data.error : `HTTP ${res.status}`);
  }
  return schema.parse(body);
}

const userPath = (userId: string) => `/users/${encodeURIComponent(userId)}`;

export async function listEvents(userId: string, limit = 100): Promise<InboxEvent[]> {
  const r = await request(`${userPath(userId)}/events?limit=${limit}`, listEventsResponseSchema);
  return r.events;
}

export async function listMessages(userId: string, limit = 100): Promise<StoredMessage[]> {
  const r = await request(`${userPath(userId)}/messages?limit=${limit}`, listMessagesResponseSchema);
  return r.messages;
}

export function postEvent(userId: string, body: PostEventBody): Promise<PostEventResponse> {
  return request(`${userPath(userId)}/events`, postEventResponseSchema, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
