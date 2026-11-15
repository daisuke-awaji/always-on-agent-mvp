import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, listMemory, listTimers, readMemoryFile } from '../api/client';
import type { MemoryFile, MemoryFileMeta, Timer } from '../api/schema';

const POLL_MS = 2000;

export interface Resource<T> {
  data?: T;
  /** 初回の読み込みが終わったか */
  loaded: boolean;
  /** 直近の読み込みが失敗したときの理由（前回のデータは残す） */
  error?: string;
  /** 404 だった（ファイルが消えた、など） */
  notFound: boolean;
  refresh: () => void;
}

/**
 * 1 つの GET を定期的に読み直す。エージェントは run のたびにタイマーやメモリを書き換えるので、
 * 開いているあいだはポーリングで追う（実際の API にも push はない）。ページが裏にあるあいだは読まない。
 * key が変わったら、前のデータは捨てる（別のファイルを開いたとき）。
 */
export function usePolled<T>(key: string | undefined, load: () => Promise<T>): Resource<T> {
  const [state, setState] = useState<{ key?: string; data?: T; loaded: boolean; error?: string; notFound: boolean }>({
    loaded: false,
    notFound: false,
  });
  // 読み込みの関数は描画のたびに作り直されるので、最新のものを ref に入れておく（描画が終わってから）
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const now = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (key === undefined) return;
    let alive = true;
    let seq = 0;
    const run = async () => {
      if (document.visibilityState === 'hidden') return;
      const mine = ++seq;
      try {
        const data = await loadRef.current();
        if (alive && mine === seq) setState({ key, data, loaded: true, notFound: false });
      } catch (err) {
        if (!alive || mine !== seq) return;
        const notFound = err instanceof ApiError && err.status === 404;
        setState((s) => ({
          key,
          data: s.key === key && !notFound ? s.data : undefined,
          loaded: true,
          notFound,
          error: notFound ? undefined : err instanceof Error ? err.message : String(err),
        }));
      }
    };
    now.current = () => {
      void run();
    };
    void run();
    const t = setInterval(() => {
      void run();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key]);

  const refresh = useCallback(() => {
    now.current();
  }, []);
  const same = state.key === key;
  return {
    data: same ? state.data : undefined,
    loaded: same && state.loaded,
    error: same ? state.error : undefined,
    notFound: same && state.notFound,
    refresh,
  };
}

export function useTimers(userId: string): Resource<Timer[]> {
  return usePolled(`timers:${userId}`, () => listTimers(userId));
}

export function useMemoryList(
  userId: string,
): Resource<{ files: MemoryFileMeta[]; limits: { maxFileBytes: number; maxFiles: number } }> {
  return usePolled(`memory:${userId}`, () => listMemory(userId));
}

export function useMemoryFile(userId: string, path: string | undefined): Resource<MemoryFile> {
  return usePolled(path === undefined ? undefined : `memory:${userId}:${path}`, () =>
    readMemoryFile(userId, path ?? ''),
  );
}
