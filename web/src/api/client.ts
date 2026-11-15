import type { z } from 'zod';
import {
  errorResponseSchema,
  listEventsResponseSchema,
  listMemoryResponseSchema,
  listMessagesResponseSchema,
  listTimersResponseSchema,
  memoryFileResponseSchema,
  postEventResponseSchema,
  timerResponseSchema,
  type CreateTimerBody,
  type InboxEvent,
  type MemoryFile,
  type MemoryFileMeta,
  type PostEventBody,
  type PostEventResponse,
  type StoredMessage,
  type Timer,
  type UpdateTimerBody,
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

async function request<T>(path: string, schema: z.ZodType<T> | undefined, init?: RequestInit): Promise<T> {
  // 相対パス（モック）でも絶対 URL（実際の API）でも動くよう、ページの URL を基準に組み立てる
  const url = new URL(`${API_BASE}${path}`, globalThis.location.href);
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json' } });
  const body: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) {
    const parsed = errorResponseSchema.safeParse(body);
    throw new ApiError(res.status, parsed.success ? parsed.data.error : `HTTP ${res.status}`);
  }
  return (schema ? schema.parse(body) : undefined) as T;
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

// ---- Timers ----

export async function listTimers(userId: string): Promise<Timer[]> {
  const r = await request(`${userPath(userId)}/timers`, listTimersResponseSchema);
  return r.timers;
}

export async function createTimer(userId: string, body: CreateTimerBody): Promise<Timer> {
  const r = await request(`${userPath(userId)}/timers`, timerResponseSchema, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return r.timer;
}

export async function updateTimer(userId: string, timerId: string, body: UpdateTimerBody): Promise<Timer> {
  const r = await request(`${userPath(userId)}/timers/${encodeURIComponent(timerId)}`, timerResponseSchema, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return r.timer;
}

export async function cancelTimer(userId: string, timerId: string): Promise<Timer> {
  const r = await request(`${userPath(userId)}/timers/${encodeURIComponent(timerId)}`, timerResponseSchema, {
    method: 'DELETE',
  });
  return r.timer;
}

// ---- Memory ----

/** "notes/family.md" → "notes/family.md"（区切りの / は残し、それぞれの部分だけを符号化する） */
const memoryPath = (userId: string, path: string) =>
  `${userPath(userId)}/memory/${path.split('/').map(encodeURIComponent).join('/')}`;

export async function listMemory(
  userId: string,
): Promise<{ files: MemoryFileMeta[]; limits: { maxFileBytes: number; maxFiles: number } }> {
  return request(`${userPath(userId)}/memory`, listMemoryResponseSchema);
}

export async function readMemoryFile(userId: string, path: string): Promise<MemoryFile> {
  const r = await request(memoryPath(userId, path), memoryFileResponseSchema);
  return r.file;
}

/** version は読んだときの版。あいだにエージェントが書き換えていたら 409（ApiError）になる */
export async function writeMemoryFile(
  userId: string,
  path: string,
  content: string,
  version: string,
): Promise<MemoryFile> {
  const r = await request(memoryPath(userId, path), memoryFileResponseSchema, {
    method: 'PUT',
    body: JSON.stringify({ content, version }),
  });
  return r.file;
}

export async function deleteMemoryFile(userId: string, path: string, version: string): Promise<void> {
  await request<undefined>(`${memoryPath(userId, path)}?version=${encodeURIComponent(version)}`, undefined, {
    method: 'DELETE',
  });
}
