import type { Actor, MemoryFile, MemoryFileMeta, Recurrence, Timer, TimerKind } from '../api/schema';
import { byteLength } from '../ui/memory';
import { expressionOf, nextOccurrence, normalizeRecurrence, TIMEZONE } from '../ui/timers';

/**
 * タイマーとメモリの 1 件ずつの作り方。API（画面から）とエージェントの真似（run の結果）とデモの履歴で同じものを使う。
 * 実際の構成の Timers テーブルと S3 の memory/<userId>/ の代わり。
 */

export interface MemoryEntry {
  content: string;
  updatedAt: string;
  updatedBy: Actor;
  /** 書くたびに 1 つ増える（実際の構成では S3 の ETag） */
  rev: number;
}

/** userId → path → ファイル（どちらも、ないことがある） */
export type MemoryTable = Partial<Record<string, Partial<Record<string, MemoryEntry>>>>;

export interface TimerInput {
  userId: string;
  kind: TimerKind;
  title: string;
  note?: string;
  /** follow-up の時刻。schedule では recurrence から決める */
  dueAt?: string;
  recurrence?: Recurrence;
  createdBy: Actor;
  sessionId?: string;
}

export function makeTimer(input: TimerInput, now: Date, timerId: string = crypto.randomUUID()): Timer {
  const recurrence = input.kind === 'schedule' && input.recurrence ? normalizeRecurrence(input.recurrence) : undefined;
  const dueAt = recurrence ? nextOccurrence(recurrence, now).toISOString() : (input.dueAt ?? now.toISOString());
  const at = now.toISOString();
  return {
    timerId,
    userId: input.userId,
    kind: input.kind,
    title: input.title,
    note: input.note || undefined,
    createdBy: input.createdBy,
    sessionId: input.kind === 'followup' ? input.sessionId : undefined,
    status: 'active',
    dueAt,
    recurrence,
    timezone: TIMEZONE,
    expression: expressionOf(input.kind, dueAt, recurrence),
    createdAt: at,
    updatedAt: at,
  };
}

/** 中身や時刻を変えたあとに、式と次の回を合わせ直す */
export function refreshTimer(t: Timer, now: Date): void {
  if (t.kind === 'schedule' && t.recurrence) {
    t.recurrence = normalizeRecurrence(t.recurrence);
    t.dueAt = nextOccurrence(t.recurrence, now).toISOString();
  }
  t.expression = expressionOf(t.kind, t.dueAt, t.recurrence);
  t.updatedAt = now.toISOString();
}

export const versionOf = (e: MemoryEntry) => `v${String(e.rev)}`;

export function metaOf(path: string, e: MemoryEntry): MemoryFileMeta {
  return { path, size: byteLength(e.content), updatedAt: e.updatedAt, updatedBy: e.updatedBy, version: versionOf(e) };
}

export function fileOf(path: string, e: MemoryEntry): MemoryFile {
  return { ...metaOf(path, e), content: e.content };
}

export function writeEntry(table: MemoryTable, userId: string, path: string, content: string, by: Actor, now: Date) {
  const files = (table[userId] ??= {});
  const prev = files[path];
  const next: MemoryEntry = { content, updatedAt: now.toISOString(), updatedBy: by, rev: (prev?.rev ?? 0) + 1 };
  files[path] = next;
  return next;
}

// ---- エージェントの run の結果（brain.ts が返す） ----

/** メモリへの書き込み。append はファイルの最後に行を足す（なければ header から作る） */
export type MemoryWrite = { path: string; content: string } | { path: string; append: string; header?: string };

export interface Effects {
  memory: MemoryWrite[];
  timers: Omit<TimerInput, 'userId' | 'createdBy' | 'sessionId'>[];
}

export const noEffects = (): Effects => ({ memory: [], timers: [] });

/** run の結果をデータに反映する。follow-up は、その run の会話の続きとして起きる */
export function applyEffects(
  target: { timers: Timer[]; memory: MemoryTable },
  userId: string,
  sessionId: string,
  effects: Effects,
  now: Date,
  newId?: () => string,
): void {
  for (const w of effects.memory) {
    if ('content' in w) {
      writeEntry(target.memory, userId, w.path, w.content, 'agent', now);
      continue;
    }
    const prev = target.memory[userId]?.[w.path]?.content ?? w.header ?? '';
    const sep = prev === '' || prev.endsWith('\n') ? '' : '\n';
    writeEntry(target.memory, userId, w.path, `${prev}${sep}${w.append}\n`, 'agent', now);
  }
  for (const spec of effects.timers) {
    target.timers.push(makeTimer({ ...spec, userId, createdBy: 'agent', sessionId }, now, newId?.()));
  }
}
