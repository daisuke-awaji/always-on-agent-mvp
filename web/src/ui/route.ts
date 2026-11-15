import { useCallback, useEffect, useState } from 'react';

/**
 * 画面の場所。sub は開いている会話（sessionId、仮の会話の e:<eventId>、新しい会話の new）。
 * sub がなければ会話の一覧。
 */
export interface Location {
  sub?: string;
}

/**
 * `#/chat/s-123` → { sub: 's-123' }。`#/`、`#/chat`、知らない場所は一覧にする。
 * 前にあった `#/inbox/…` や `#/console` のリンクも、壊れずに一覧が開く。
 */
export function parseHash(hash: string): Location {
  const [head = '', ...rest] = hash.replace(/^#\/?/, '').split('/');
  const sub = head === 'chat' ? rest.join('/') : '';
  return sub ? { sub: decodeURIComponent(sub) } : {};
}

export function toHash({ sub }: Location): string {
  return sub ? `#/chat/${encodeURIComponent(sub)}` : '#/';
}

/** 一覧から開いた会話の履歴に付ける印。これがあれば「戻る」は history.back() でよい */
interface HistoryMark {
  fromList?: true;
}

/**
 * URL（hash）で画面の場所を持つ。一覧 → 会話を履歴に積むので、
 * スマホの「戻る」（Android の戻る操作、iOS のスワイプ）で一覧に戻れる。
 */
export function useLocation() {
  const [loc, setLoc] = useState<Location>(() => parseHash(window.location.hash));

  useEffect(() => {
    const on = () => {
      const next = parseHash(window.location.hash);
      // 前にあった画面（#/inbox/… など）や知らない場所は、アドレスバーも一覧（#/）に直す
      if (window.location.hash && !next.sub && window.location.hash !== toHash(next)) {
        window.history.replaceState(window.history.state, '', toHash(next));
      }
      setLoc(next);
    };
    on();
    window.addEventListener('popstate', on);
    window.addEventListener('hashchange', on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('hashchange', on);
    };
  }, []);

  /** 一覧から会話を開く（履歴に積む） */
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

  /** 会話から一覧へ戻る。一覧から来たなら履歴を戻し、URL を直接開いたなら一覧に置き換える */
  const backToList = useCallback(() => {
    if ((window.history.state as HistoryMark | null)?.fromList) {
      window.history.back();
    } else {
      window.history.replaceState(null, '', toHash({}));
      setLoc({});
    }
  }, []);

  return { loc, open, replace, backToList };
}

export type Navigation = Omit<ReturnType<typeof useLocation>, 'loc'>;
