import { z } from 'zod';

/**
 * 実際の API（src/functions/handler.ts）が返す JSON の形。
 * 型の元は src/shared/types.ts と src/shared/message-repo.ts。モックも同じ形を返す。
 */
export const eventStatusSchema = z.enum(['pending', 'processing', 'done', 'failed']);
export type EventStatus = z.infer<typeof eventStatusSchema>;

export const eventTypeSchema = z.enum(['user_message', 'webhook', 'system']);
export type EventType = z.infer<typeof eventTypeSchema>;

export const inboxEventSchema = z.object({
  eventId: z.string(),
  userId: z.string(),
  type: eventTypeSchema,
  source: z.string(),
  sourceEventId: z.string().optional(),
  sessionId: z.string().optional(),
  payload: z.unknown(),
  status: eventStatusSchema,
  attempts: z.number(),
  receivedAt: z.string(),
  updatedAt: z.string(),
  runId: z.string().optional(),
  lastError: z.string().optional(),
  sk: z.string(),
});
export type InboxEvent = z.infer<typeof inboxEventSchema>;

export const storedMessageSchema = z.object({
  messageId: z.string(),
  userId: z.string(),
  runId: z.string(),
  sessionId: z.string(),
  importance: z.enum(['normal', 'high']),
  text: z.string(),
  createdAt: z.string(),
});
export type StoredMessage = z.infer<typeof storedMessageSchema>;

export const listEventsResponseSchema = z.object({ events: z.array(inboxEventSchema) });
export const listMessagesResponseSchema = z.object({ messages: z.array(storedMessageSchema) });
export const postEventResponseSchema = z.object({
  eventId: z.string(),
  status: eventStatusSchema,
  duplicate: z.boolean(),
});
export type PostEventResponse = z.infer<typeof postEventResponseSchema>;
export const errorResponseSchema = z.object({ error: z.string() });

/** POST /users/{userId}/events の本文 */
export type PostEventBody =
  | { text: string; sessionId?: string }
  | { type: EventType; source: string; sourceEventId?: string; sessionId?: string; payload: unknown };

export const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const SESSION_ID_PATTERN = /^s-[0-9a-f-]{36}$/;

// ---- Timers（まだ実際の API にはない。モックで形を決める） ----
//
//   GET    /users/{userId}/timers            → 200 { timers }
//   POST   /users/{userId}/timers            → 201 { timer }
//   PATCH  /users/{userId}/timers/{timerId}  → 200 { timer }  （動いているものだけ。終わったものは 409）
//   DELETE /users/{userId}/timers/{timerId}  → 200 { timer }  （status: cancelled にする。消さずに残す）
//
// 記事の 2 種類: follow-up はエージェントが自分で決める 1 回だけの期限、schedule は決まった周期の繰り返し。
// 実際の構成では Timers テーブル + EventBridge Scheduler（at() / cron()）で動かし、時刻が来たら
// handler に system イベント（source: scheduler）を入れる。

export const timerKindSchema = z.enum(['followup', 'schedule']);
export type TimerKind = z.infer<typeof timerKindSchema>;
export const timerStatusSchema = z.enum(['active', 'done', 'cancelled']);
export type TimerStatus = z.infer<typeof timerStatusSchema>;
export const actorSchema = z.enum(['agent', 'user']);
export type Actor = z.infer<typeof actorSchema>;

/** 繰り返し。time は "HH:MM"、weekdays は 0（日）〜 6（土）、dayOfMonth は 1〜28 */
export const recurrenceSchema = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly']),
  time: z.string(),
  weekdays: z.array(z.number()).optional(),
  dayOfMonth: z.number().optional(),
});
export type Recurrence = z.infer<typeof recurrenceSchema>;

export const timerSchema = z.object({
  timerId: z.string(),
  userId: z.string(),
  kind: timerKindSchema,
  /** エージェントがそのとき何をするか（画面の題名） */
  title: z.string(),
  /** エージェントへの補足（起きたときに読む） */
  note: z.string().optional(),
  createdBy: actorSchema,
  /** follow-up を作った会話。時刻が来たら、この会話の続きとして起きる */
  sessionId: z.string().optional(),
  status: timerStatusSchema,
  /** 次に動く時刻。follow-up は 1 回だけ、schedule は動くたびに次の回に進む */
  dueAt: z.string(),
  recurrence: recurrenceSchema.optional(),
  timezone: z.string(),
  /** EventBridge Scheduler の式（at(...) / cron(...)） */
  expression: z.string(),
  lastFiredAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Timer = z.infer<typeof timerSchema>;

export const listTimersResponseSchema = z.object({ timers: z.array(timerSchema) });
export const timerResponseSchema = z.object({ timer: timerSchema });

/** POST /users/{userId}/timers の本文（画面から作るときは createdBy: user） */
export type CreateTimerBody =
  | { kind: 'followup'; title: string; note?: string; dueAt: string }
  | { kind: 'schedule'; title: string; note?: string; recurrence: Recurrence };

/** PATCH /users/{userId}/timers/{timerId} の本文（種類は変えられない） */
export interface UpdateTimerBody {
  title?: string;
  note?: string;
  dueAt?: string;
  recurrence?: Recurrence;
}

export const TIMER_LIMITS = { maxTitle: 80, maxNote: 500, maxActive: 30, maxDaysAhead: 366 };

// ---- Memory（まだ実際の API にはない。src/agent/memory.ts と同じファイルを読み書きする） ----
//
//   GET    /users/{userId}/memory                 → 200 { files, limits }
//   GET    /users/{userId}/memory/{path}          → 200 { file }（content を含む）
//   PUT    /users/{userId}/memory/{path}          → 200 { file }  本文 { content, version }
//   DELETE /users/{userId}/memory/{path}?version= → 204
//
// version は読んだときの版（実際の構成では S3 の ETag）。エージェントがあいだに書き換えていたら 409 を返し、
// 上書きしない。毎回読み込むファイル（instructions.md と 2 つの index.md）は直せるが、消せない（400）。

export const memoryFileMetaSchema = z.object({
  path: z.string(),
  size: z.number(),
  updatedAt: z.string(),
  updatedBy: actorSchema,
  version: z.string(),
});
export type MemoryFileMeta = z.infer<typeof memoryFileMetaSchema>;
export const memoryFileSchema = memoryFileMetaSchema.extend({ content: z.string() });
export type MemoryFile = z.infer<typeof memoryFileSchema>;

export const memoryLimitsSchema = z.object({ maxFileBytes: z.number(), maxFiles: z.number() });
export const listMemoryResponseSchema = z.object({
  files: z.array(memoryFileMetaSchema),
  limits: memoryLimitsSchema,
});
export const memoryFileResponseSchema = z.object({ file: memoryFileSchema });

/** src/agent/memory.ts の AUTOLOAD_FILES と MEMORY_LIMITS と同じ値 */
export const AUTOLOAD_FILES = ['instructions.md', 'notes/index.md', 'tasks/index.md'] as const;
export const MEMORY_LIMITS = { maxFileBytes: 32 * 1024, maxFiles: 200, maxDepth: 4, maxPathLength: 200 };
