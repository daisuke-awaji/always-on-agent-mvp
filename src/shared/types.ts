/**
 * Handler / Worker / Agent の間で共有する契約。
 *
 * 記事の用語との対応:
 *   - Event      … inbox に積まれる 1 件のイベント（ユーザー発話、Webhook など）
 *   - Run        … イベントを受けてエージェントが 1 回働く単位
 *   - Session    … メッセージとツール呼び出しの記録（複数 run にまたがる）
 */

export type EventStatus = 'pending' | 'processing' | 'done' | 'failed';

export type EventType = 'user_message' | 'webhook' | 'system';

/** inbox に保存されるイベント */
export interface InboxEvent {
  eventId: string;
  userId: string;
  type: EventType;
  /** 送信元（例: "user", "github", "backlog"） */
  source: string;
  /** 送信元が採番した一意 ID。重複排除に使う */
  sourceEventId?: string;
  /** 既存 session の続きなら指定（ユーザーの返信など） */
  sessionId?: string;
  payload: unknown;
  status: EventStatus;
  attempts: number;
  receivedAt: string;
  updatedAt: string;
  runId?: string;
  lastError?: string;
  /** DynamoDB のソートキー（EVT#<receivedAt>#<eventId>） */
  sk: string;
}

/** Agent に渡すイベント（内部管理用の属性は落とす） */
export interface RunEvent {
  eventId: string;
  type: EventType;
  source: string;
  receivedAt: string;
  payload: unknown;
}

export interface SentMessageView {
  createdAt: string;
  sessionId: string;
  text: string;
}

/** Worker → Agent（AgentCore Runtime /invocations） */
export interface RunRequest {
  runId: string;
  userId: string;
  sessionId: string;
  events: RunEvent[];
  /** 直近に送ったメッセージ（同じことを繰り返さないため。worker が読み込んで渡す） */
  recentMessages: SentMessageView[];
}

export type RunOutcome = 'sent' | 'silent';

/** Agent → Worker */
export interface RunResult {
  runId: string;
  sessionId: string;
  outcome: RunOutcome;
  messagesSent: number;
  turns: number;
  stopReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheWriteInputTokens: number;
  };
}

/** SQS FIFO に流す wake 信号。中身は最小限で、正は常に inbox */
export interface WakeMessage {
  userId: string;
  eventSk?: string;
}

export const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** AgentCore Runtime の runtimeSessionId は 33 文字以上が必要 */
export const SESSION_ID_PATTERN = /^s-[0-9a-f-]{36}$/;

export function isValidUserId(v: unknown): v is string {
  return typeof v === 'string' && USER_ID_PATTERN.test(v);
}

export function isValidSessionId(v: unknown): v is string {
  return typeof v === 'string' && SESSION_ID_PATTERN.test(v);
}
