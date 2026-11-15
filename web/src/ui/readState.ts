import { useSyncExternalStore } from 'react';

/**
 * エージェントのメッセージの既読。API にはない、この画面だけの状態（localStorage に messageId を持つ）。
 * 会話の一覧（会話ごとの未読数）と上のバー・ブラウザのタブ名（全体の未読数）で同じ値を使うので、小さなストアにしてある。
 */
const KEY = 'aoa-ui:read-messages';
const listeners = new Set<() => void>();
let read: ReadonlySet<string> = load();

function load(): ReadonlySet<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** まとめて既読にする。会話を開いたときに、その会話のメッセージをまとめて渡す */
export function markRead(messageIds: readonly string[]): void {
  const fresh = messageIds.filter((id) => !read.has(id));
  if (fresh.length === 0) return;
  read = new Set([...read, ...fresh]);
  try {
    localStorage.setItem(KEY, JSON.stringify([...read]));
  } catch {
    // 保存できなくても（容量・プライベートブラウズ）、この画面を開いている間は既読として扱う
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useRead(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => read,
    () => read,
  );
}
