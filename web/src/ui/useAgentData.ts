import { useCallback, useEffect, useRef, useState } from 'react';
import { listEvents, listMessages } from '../api/client';
import type { InboxEvent, StoredMessage } from '../api/schema';

const POLL_MS = 1500;

export interface AgentData {
  events: InboxEvent[];
  messages: StoredMessage[];
  /** 初回の読み込みが終わったか */
  loaded: boolean;
  /** 直近の読み込みが失敗したときの理由（前回のデータは残す） */
  error?: string;
  refresh: () => void;
}

/**
 * イベントとメッセージを定期的に読み直す。実際の API にも push はないので、ポーリングで追う。
 * 失敗しても前回のデータは消さない（画面が真っ白にならないように）。
 */
export function useAgentData(userId: string): AgentData {
  const [events, setEvents] = useState<InboxEvent[]>([]);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const loadNow = useRef<() => void>(() => undefined);

  useEffect(() => {
    let alive = true;
    let seq = 0;
    const load = async () => {
      const mySeq = ++seq;
      try {
        const [ev, msg] = await Promise.all([listEvents(userId), listMessages(userId)]);
        if (!alive || mySeq !== seq) return; // 古い応答は捨てる
        setEvents(ev);
        setMessages(msg);
        setError(undefined);
      } catch (err) {
        if (!alive || mySeq !== seq) return;
        setError(err instanceof Error ? err.message : String(err));
      }
      setLoaded(true);
    };
    loadNow.current = () => {
      void load();
    };
    void load();
    const t = setInterval(() => {
      void load();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [userId]);

  const refresh = useCallback(() => {
    loadNow.current();
  }, []);
  return { events, messages, loaded, error, refresh };
}

/** 相対時刻の表示を更新するための時計 */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(t);
    };
  }, [intervalMs]);
  return now;
}
