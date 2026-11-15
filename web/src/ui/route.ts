import { useCallback, useEffect, useState } from 'react';

export type Route = 'overview' | 'chat' | 'inbox' | 'console';

/** 画面の場所。sub は一覧の中の 1 件（会話の sessionId、連絡の messageId など） */
export interface Location {
  route: Route;
  sub?: string;
}

const ROUTES = new Set<Route>(['chat', 'inbox', 'console']);

/** `#/chat/s-123` → { route: 'chat', sub: 's-123' }。知らない場所は概要にする */
export function parseHash(hash: string): Location {
  const [head = '', ...rest] = hash.replace(/^#\/?/, '').split('/');
  if (!ROUTES.has(head as Route)) return { route: 'overview' };
  const sub = rest.join('/');
  return sub ? { route: head as Route, sub: decodeURIComponent(sub) } : { route: head as Route };
}

export function toHash({ route, sub }: Location): string {
  if (route === 'overview') return '#/';
  return sub ? `#/${route}/${encodeURIComponent(sub)}` : `#/${route}`;
}

/** 一覧から開いた詳細の履歴に付ける印。これがあれば「戻る」は history.back() でよい */
interface HistoryMark {
  fromList?: true;
}

/**
 * URL（hash）で画面の場所を持つ。一覧 → 詳細を履歴に積むので、
 * スマホの「戻る」（Android の戻る操作、iOS のスワイプ）で一覧に戻れる。
 */
export function useLocation() {
  const [loc, setLoc] = useState<Location>(() => parseHash(window.location.hash));

  useEffect(() => {
    const on = () => {
      setLoc(parseHash(window.location.hash));
    };
    window.addEventListener('popstate', on);
    window.addEventListener('hashchange', on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('hashchange', on);
    };
  }, []);

  /** 一覧から詳細を開く（履歴に積む） */
  const open = useCallback((next: Location) => {
    const mark: HistoryMark = { fromList: true };
    window.history.pushState(mark, '', toHash(next));
    setLoc(next);
  }, []);

  /** 履歴を増やさずに場所を差し替える（送信後に仮の会話を本物に置き換えるときなど） */
  const replace = useCallback((next: Location) => {
    window.history.replaceState(window.history.state, '', toHash(next));
    setLoc(next);
  }, []);

  /** 詳細から一覧へ戻る。一覧から来たなら履歴を戻し、URL を直接開いたなら一覧に置き換える */
  const backToList = useCallback((route: Route) => {
    if ((window.history.state as HistoryMark | null)?.fromList) {
      window.history.back();
    } else {
      window.history.replaceState(null, '', toHash({ route }));
      setLoc({ route });
    }
  }, []);

  return { loc, open, replace, backToList };
}

export type Navigation = Omit<ReturnType<typeof useLocation>, 'loc'>;
