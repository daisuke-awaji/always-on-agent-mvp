import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 画面の場所。view は画面（なければ会話）、sub はその画面で開いているもの:
 *   会話     #/chat/<sessionId>      sessionId、仮の会話の e:<eventId>、新しい会話の new
 *   タイマー #/timers/<timerId>      new は新しいタイマー
 *   メモリ   #/memory/<path>         notes/family.md など（/ はそのまま）
 * sub がなければ、その画面の一覧。
 */
export type View = 'timers' | 'memory';

export interface Location {
  view?: View;
  sub?: string;
}

const VIEWS: readonly View[] = ['timers', 'memory'];

/**
 * `#/chat/s-123` → { sub: 's-123' }、`#/timers/t-1` → { view: 'timers', sub: 't-1' }。
 * `#/`、`#/chat`、知らない場所は会話の一覧にする。前にあった `#/inbox/…` や `#/console` のリンクも、壊れずに一覧が開く。
 */
export function parseHash(hash: string): Location {
  const [head = '', ...rest] = hash.replace(/^#\/?/, '').split('/');
  const sub = rest.filter(Boolean).map(safeDecode).join('/');
  const view = VIEWS.find((v) => v === head);
  if (view) return sub ? { view, sub } : { view };
  return head === 'chat' && sub ? { sub } : {};
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function toHash({ view, sub }: Location): string {
  // メモリのパスは / を区切りのまま残す（アドレスバーで読める）。会話とタイマーの ID は 1 つの部分にする
  if (view === 'memory') return sub ? `#/memory/${sub.split('/').map(encodeURIComponent).join('/')}` : '#/memory';
  if (view) return sub ? `#/${view}/${encodeURIComponent(sub)}` : `#/${view}`;
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
  // コールバック（backToList / go）から今の場所を読むため。描画が終わってから合わせる
  const current = useRef(loc);
  useEffect(() => {
    current.current = loc;
  }, [loc]);

  useEffect(() => {
    const on = () => {
      const next = parseHash(window.location.hash);
      // 前にあった画面（#/inbox/… など）や知らない場所は、アドレスバーも一覧（#/）に直す
      if (window.location.hash && !next.sub && !next.view && window.location.hash !== toHash(next)) {
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

  /** 開いているものから、同じ画面の一覧へ戻る。一覧から来たなら履歴を戻し、URL を直接開いたなら一覧に置き換える */
  const backToList = useCallback(() => {
    if ((window.history.state as HistoryMark | null)?.fromList) {
      window.history.back();
    } else {
      const list: Location = current.current.view ? { view: current.current.view } : {};
      window.history.replaceState(null, '', toHash(list));
      setLoc(list);
    }
  }, []);

  /** 画面を切り替える（会話 / タイマー / メモリ）。履歴に積むので、「戻る」で前の画面に戻れる */
  const go = useCallback((view: View | undefined) => {
    const next: Location = view ? { view } : {};
    if (toHash(next) === toHash(current.current)) return;
    window.history.pushState(null, '', toHash(next));
    setLoc(next);
  }, []);

  return { loc, open, replace, backToList, go };
}

export type Navigation = Omit<ReturnType<typeof useLocation>, 'loc'>;
