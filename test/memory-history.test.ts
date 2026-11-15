import type { Message } from '@aws-sdk/client-bedrock-runtime';
import { describe, expect, it } from 'vitest';
import { appendUserContent, trimHistory, withTrailingCachePoint } from '../src/agent/history.js';
import { MEMORY_LIMITS, MemoryStore, normalizeMemoryPath } from '../src/agent/memory.js';
import { MemFileStore } from './fakes.js';

describe('normalizeMemoryPath', () => {
  it.each([
    ['', ''],
    ['/', ''],
    ['/memories', ''],
    ['/memories/notes/index.md', 'notes/index.md'],
    ['notes/', 'notes'],
    ['tasks\\t-1.md', 'tasks/t-1.md'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeMemoryPath(input).path).toBe(expected);
  });

  it.each(['../x.md', 'notes/../../x', 'a/./b', '.hidden', 'a b.md', 'a/b/c/d/e.md', 'x'.repeat(201)])(
    '拒否: %j',
    (p) => {
      expect(() => normalizeMemoryPath(p)).toThrow();
    },
  );
});

describe('MemoryStore', () => {
  it('ユーザーのプレフィックスの中だけを読み書きする', async () => {
    const files = new MemFileStore();
    const alice = new MemoryStore(files, 'alice');
    const bob = new MemoryStore(files, 'bob');
    await alice.execute({ command: 'create', path: 'notes/index.md', file_text: '- role.md: 役割' });
    expect([...files.files.keys()]).toEqual(['memory/alice/notes/index.md']);
    expect(await bob.execute({ command: 'view', path: '' })).toBe('(メモリは空です)');
    expect(await alice.execute({ command: 'view', path: '/' })).toBe('notes/index.md\t17B');
    expect(await alice.execute({ command: 'view', path: 'notes/index.md' })).toBe('- role.md: 役割');
  });

  it('str_replace は 1 回だけ出現する文字列のみ置換する', async () => {
    const m = new MemoryStore(new MemFileStore(), 'u');
    await m.execute({ command: 'create', path: 'tasks/index.md', file_text: '- a: todo\n- b: todo\n' });
    await expect(
      m.execute({ command: 'str_replace', path: 'tasks/index.md', old_str: 'todo', new_str: 'done' }),
    ).rejects.toThrow('found 2');
    await m.execute({ command: 'str_replace', path: 'tasks/index.md', old_str: '- a: todo', new_str: '- a: done $&' });
    expect(await m.read('tasks/index.md')).toBe('- a: done $&\n- b: todo\n'); // 置換文字列の $& を特殊扱いしない
  });

  it('サイズとファイル数の上限', async () => {
    const m = new MemoryStore(new MemFileStore(), 'u');
    await expect(
      m.execute({ command: 'create', path: 'big.md', file_text: 'x'.repeat(MEMORY_LIMITS.maxFileBytes + 1) }),
    ).rejects.toThrow('too large');
    for (let i = 0; i < MEMORY_LIMITS.maxFiles; i++)
      await m.execute({ command: 'create', path: `n/${i}.md`, file_text: 'x' });
    await expect(m.execute({ command: 'create', path: 'n/extra.md', file_text: 'x' })).rejects.toThrow(
      'too many files',
    );
    await expect(m.execute({ command: 'create', path: 'n/0.md', file_text: 'overwrite ok' })).resolves.toBe(
      'overwrote n/0.md',
    );
  });

  it('delete と存在しないファイル', async () => {
    const m = new MemoryStore(new MemFileStore(), 'u');
    await expect(m.execute({ command: 'delete', path: 'nope.md' })).rejects.toThrow('not found');
    await expect(m.execute({ command: 'delete', path: '' })).rejects.toThrow('root');
    await expect(m.execute({ command: 'view', path: 'nope.md' })).rejects.toThrow('not found');
  });
});

const user = (text: string): Message => ({ role: 'user', content: [{ text }] });
const asst = (text: string): Message => ({ role: 'assistant', content: [{ text }] });
const toolUse = (id: string): Message => ({
  role: 'assistant',
  content: [{ toolUse: { toolUseId: id, name: 'memory', input: {} } }],
});
const toolResult = (id: string): Message => ({
  role: 'user',
  content: [{ toolResult: { toolUseId: id, content: [{ text: 'ok' }] } }],
});

describe('history', () => {
  it('最後が user ならそこにまとめる（user / assistant の交互を保つ）', () => {
    const merged = appendUserContent([user('a'), toolUse('t1'), toolResult('t1')], [{ text: 'new' }]);
    expect(merged).toHaveLength(3);
    expect(merged[2].content).toHaveLength(2);
    expect(appendUserContent([user('a'), asst('b')], [{ text: 'c' }])).toHaveLength(3);
  });

  it('trimHistory は toolUse / toolResult の対を壊さず、通常の user ターンから始める', () => {
    const msgs = [user('1'), asst('1'), user('2'), toolUse('t'), toolResult('t'), asst('2'), user('3'), asst('3')];
    const trimmed = trimHistory(msgs, { maxMessages: 5, maxChars: 1e9 });
    expect(trimmed[0]).toEqual(user('3'));
    expect(trimHistory(msgs, { maxMessages: 6, maxChars: 1e9 })[0]).toEqual(user('2'));
    expect(trimHistory(msgs, { maxMessages: 100, maxChars: 1e9 })).toBe(msgs);
  });

  it('cachePoint は送信用のコピーにだけ付ける', () => {
    const msgs = [user('a')];
    const sent = withTrailingCachePoint(msgs);
    expect(sent[0].content).toHaveLength(2);
    expect(msgs[0].content).toHaveLength(1);
  });
});
