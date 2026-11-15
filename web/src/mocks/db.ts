import type { EventType, InboxEvent, StoredMessage } from '../api/schema';
import { seedFor, type ScenarioId } from './scenarios';

/**
 * モックのデータ置き場。実際の構成の InboxTable と MessagesTable の代わり。
 * ブラウザの localStorage に保存するので、再読み込みしても残る。
 */
export interface MockState {
  version: 1;
  scenario: ScenarioId;
  events: InboxEvent[];
  messages: StoredMessage[];
  /** `${userId}|${source}|${sourceEventId}` → eventId（実際の構成の重複排除アイテム） */
  dedupe: Record<string, string>;
}

const STORAGE_KEY = 'aoa-mock:v1';
let state: MockState | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function getState(): MockState {
  if (!state) {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<MockState> | null;
        // 形が変わったら（version が違えば）捨てて作り直す
        if (parsed?.version === 1) state = parsed as MockState;
      } catch {
        /* 壊れていたら作り直す */
      }
    }
    state ??= freshState('standard');
  }
  return state;
}

function freshState(scenario: ScenarioId): MockState {
  const seed = seedFor(scenario, new Date());
  return { version: 1, scenario, events: seed.events, messages: seed.messages, dedupe: seed.dedupe };
}

export function save(): void {
  if (state) storage()?.setItem(STORAGE_KEY, JSON.stringify(state));
  for (const l of listeners) l();
}

/** シナリオを切り替えて、データを初期状態に戻す */
export function resetState(scenario: ScenarioId): void {
  state = freshState(scenario);
  save();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface NewEventInput {
  userId: string;
  type: EventType;
  source: string;
  sourceEventId?: string;
  sessionId?: string;
  payload: unknown;
}

/** inbox-repo.ts の appendEvent と同じ振る舞い（sourceEventId があれば重複を捨てる） */
export function appendEvent(input: NewEventInput, now = new Date()): { event: InboxEvent; duplicate: boolean } {
  const s = getState();
  if (input.sourceEventId) {
    const key = `${input.userId}|${input.source}|${input.sourceEventId}`;
    const existingId = s.dedupe[key];
    const existing = existingId ? s.events.find((e) => e.eventId === existingId) : undefined;
    if (existing) return { event: existing, duplicate: true };
  }
  const receivedAt = now.toISOString();
  const eventId = crypto.randomUUID();
  const event: InboxEvent = {
    eventId,
    userId: input.userId,
    type: input.type,
    source: input.source,
    sourceEventId: input.sourceEventId,
    sessionId: input.sessionId,
    payload: input.payload,
    status: 'pending',
    attempts: 0,
    receivedAt,
    updatedAt: receivedAt,
    sk: `EVT#${receivedAt}#${eventId}`,
  };
  s.events.push(event);
  if (input.sourceEventId) s.dedupe[`${input.userId}|${input.source}|${input.sourceEventId}`] = eventId;
  save();
  return { event, duplicate: false };
}

/** 新しい順（実際の API は ScanIndexForward: false） */
export function listRecentEvents(userId: string, limit: number): InboxEvent[] {
  return getState()
    .events.filter((e) => e.userId === userId)
    .sort((a, b) => b.sk.localeCompare(a.sk))
    .slice(0, limit);
}

export function listRecentMessages(userId: string, limit: number): StoredMessage[] {
  return getState()
    .messages.filter((m) => m.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.messageId.localeCompare(a.messageId))
    .slice(0, limit);
}

export function openEvents(userId: string): InboxEvent[] {
  return getState()
    .events.filter((e) => e.userId === userId && (e.status === 'pending' || e.status === 'processing'))
    .sort((a, b) => a.sk.localeCompare(b.sk));
}

export function usersWithOpenEvents(): string[] {
  const s = getState();
  return [...new Set(s.events.filter((e) => e.status === 'pending' || e.status === 'processing').map((e) => e.userId))];
}
