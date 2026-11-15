import { randomUUID } from 'node:crypto';
import type { ConverseCommandInput, ContentBlock } from '@aws-sdk/client-bedrock-runtime';
import type { ConverseFn } from '../src/agent/loop.js';
import type { FileStore, SessionRecord } from '../src/agent/stores.js';
import { eventSk, type InboxRepository, type NewEventInput } from '../src/shared/inbox-repo.js';
import type { MessageRepository, StoredMessage } from '../src/shared/message-repo.js';
import type { InboxEvent } from '../src/shared/types.js';

/** MemFileStore に保存されたセッション記録を読む */
export function readSession(files: MemFileStore, userId: string, sessionId: string): SessionRecord {
  const raw = files.files.get(`sessions/${userId}/${sessionId}.json`);
  if (raw === undefined) throw new Error(`session not found: ${userId}/${sessionId}`);
  return JSON.parse(raw) as SessionRecord;
}

/** DynamoInboxRepository と同じ意味論を持つインメモリ実装 */
export class InMemoryInbox implements InboxRepository {
  events = new Map<string, InboxEvent>(); // key: userId|sk
  dedup = new Map<string, string>();
  leases = new Map<string, { owner: string; until: number }>();
  private seq = 0;
  constructor(public now: () => number = () => Date.now()) {}

  async appendEvent(input: NewEventInput) {
    if (input.sourceEventId) {
      const dk = `${input.userId}|${input.source}|${input.sourceEventId}`;
      const existing = this.dedup.get(dk);
      if (existing) return { event: structuredClone(this.events.get(existing)!), duplicate: true };
    }
    // 同じミリ秒でも順序が保たれるよう単調増加させる
    const receivedAt = new Date(this.now() + this.seq++).toISOString();
    const eventId = randomUUID();
    const sk = eventSk(receivedAt, eventId);
    const event: InboxEvent = {
      ...input,
      eventId,
      sk,
      status: 'pending',
      attempts: 0,
      receivedAt,
      updatedAt: receivedAt,
    };
    this.events.set(`${input.userId}|${sk}`, event);
    if (input.sourceEventId)
      this.dedup.set(`${input.userId}|${input.source}|${input.sourceEventId}`, `${input.userId}|${sk}`);
    return { event: structuredClone(event), duplicate: false };
  }

  private forUser(userId: string) {
    return [...this.events.entries()]
      .filter(([k]) => k.startsWith(`${userId}|`))
      .map(([, v]) => v)
      .sort((a, b) => a.sk.localeCompare(b.sk));
  }

  async listOpenEvents(userId: string) {
    return this.forUser(userId)
      .filter((e) => e.status === 'pending' || e.status === 'processing')
      .map((e) => structuredClone(e));
  }

  async listRecentEvents(userId: string, limit: number) {
    return this.forUser(userId)
      .reverse()
      .slice(0, limit)
      .map((e) => structuredClone(e));
  }

  private get(userId: string, e: InboxEvent) {
    const cur = this.events.get(`${userId}|${e.sk}`);
    if (!cur) throw new Error('not found');
    return cur;
  }

  async markProcessing(userId: string, events: InboxEvent[], runId: string) {
    for (const e of events) {
      const cur = this.get(userId, e);
      if (cur.status !== 'pending' && cur.status !== 'processing') throw new Error('ConditionalCheckFailed');
      Object.assign(cur, { status: 'processing', attempts: cur.attempts + 1, runId });
    }
  }

  async markDone(userId: string, events: InboxEvent[], runId: string) {
    for (const e of events) {
      const cur = this.get(userId, e);
      if (cur.runId !== runId) throw new Error('ConditionalCheckFailed');
      cur.status = 'done';
      delete cur.lastError;
    }
  }

  async markRetry(userId: string, events: InboxEvent[], error: string, maxAttempts: number) {
    const failed: string[] = [];
    for (const e of events) {
      const cur = this.get(userId, e);
      const giveUp = e.attempts + 1 >= maxAttempts;
      cur.status = giveUp ? 'failed' : 'pending';
      cur.lastError = error;
      if (giveUp) failed.push(e.eventId);
    }
    return { failed };
  }

  async acquireLease(userId: string, owner: string, leaseMs: number) {
    const cur = this.leases.get(userId);
    if (cur && cur.until >= this.now() && cur.owner !== owner) return false;
    this.leases.set(userId, { owner, until: this.now() + leaseMs });
    return true;
  }

  async releaseLease(userId: string, owner: string) {
    if (this.leases.get(userId)?.owner === owner) this.leases.delete(userId);
  }
}

export class InMemoryMessages implements MessageRepository {
  items: StoredMessage[] = [];
  async put(msg: Omit<StoredMessage, 'messageId' | 'createdAt'>) {
    const stored = {
      ...msg,
      messageId: randomUUID(),
      createdAt: new Date(Date.now() + this.items.length).toISOString(),
    };
    this.items.push(stored);
    return stored;
  }
  async listRecent(userId: string, limit: number) {
    return this.items
      .filter((m) => m.userId === userId)
      .reverse()
      .slice(0, limit);
  }
}

export class MemFileStore implements FileStore {
  files = new Map<string, string>();
  async get(key: string) {
    return this.files.get(key);
  }
  async put(key: string, body: string) {
    this.files.set(key, body);
  }
  async delete(key: string) {
    this.files.delete(key);
  }
  async list(prefix: string) {
    return [...this.files.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, v]) => ({ key, size: Buffer.byteLength(v) }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }
}

/** 台本どおりに応答する Converse のフェイク。呼び出し内容も記録する */
export type ScriptStep = { text?: string; tools?: { name: string; input: Record<string, unknown> }[] };

export function scriptedConverse(steps: ScriptStep[] | ((input: ConverseCommandInput, call: number) => ScriptStep)) {
  const calls: ConverseCommandInput[] = [];
  let i = 0;
  const fn: ConverseFn = async (input) => {
    calls.push(structuredClone(input));
    const step = typeof steps === 'function' ? steps(input, i) : (steps[i] ?? { text: '(終了)' });
    i++;
    const content: ContentBlock[] = [];
    if (step.text) content.push({ text: step.text });
    for (const t of step.tools ?? [])
      content.push({
        toolUse: { toolUseId: `tu-${i}-${t.name}-${randomUUID().slice(0, 4)}`, name: t.name, input: t.input as never },
      });
    return {
      output: { message: { role: 'assistant', content } },
      stopReason: step.tools?.length ? 'tool_use' : 'end_turn',
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        cacheReadInputTokens: 50,
        cacheWriteInputTokens: 0,
      },
    };
  };
  return { fn, calls };
}
