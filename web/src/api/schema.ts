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
