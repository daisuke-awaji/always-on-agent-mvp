import { useSyncExternalStore } from 'react';

/**
 * 連絡の既読。API にはない、この画面だけの状態（localStorage）。
 * 通知箱と下のタブバー（未読数）で同じ値を使うので、小さなストアにしてある。
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

export function markRead(messageId: string): void {
  if (read.has(messageId)) return;
  read = new Set(read).add(messageId);
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
