import type { Recurrence, Timer, TimerKind } from '../api/schema';
import { dateLabel, timeLabel, ymd } from './payloads';

/**
 * タイマーの時刻の計算と、画面の文言。モック（scheduler と API の検証）と画面で同じものを使う。
 * 時刻は端末の時刻で数える。実際の構成では timezone（Asia/Tokyo）で EventBridge Scheduler が数える。
 */
export const TIMEZONE = 'Asia/Tokyo';

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const CRON_DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** "07:00" / "7:00" → { h: 7, m: 0 }。読めなければ undefined */
export function parseHm(s: string): { h: number; m: number } | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? { h, m: min } : undefined;
}

/** 繰り返しの検証。おかしければ理由（API の 400 の文言）を返す */
export function recurrenceError(r: Recurrence): string | undefined {
  if (!parseHm(r.time)) return 'recurrence.time must be HH:MM';
  if (r.freq === 'weekly') {
    const w = r.weekdays ?? [];
    if (w.length === 0) return 'recurrence.weekdays is required for weekly';
    if (w.some((d) => !Number.isInteger(d) || d < 0 || d > 6) || new Set(w).size !== w.length)
      return 'recurrence.weekdays must be unique numbers 0-6';
  }
  if (r.freq === 'monthly') {
    const d = r.dayOfMonth;
    if (d === undefined || !Number.isInteger(d) || d < 1 || d > 28) return 'recurrence.dayOfMonth must be 1-28';
  }
  return undefined;
}

/** 形をそろえる（使わない項目は落とし、曜日は並べ替える） */
export function normalizeRecurrence(r: Recurrence): Recurrence {
  const hm = parseHm(r.time);
  const time = hm ? `${String(hm.h).padStart(2, '0')}:${String(hm.m).padStart(2, '0')}` : r.time;
  if (r.freq === 'weekly') return { freq: 'weekly', time, weekdays: [...(r.weekdays ?? [])].sort((a, b) => a - b) };
  if (r.freq === 'monthly') return { freq: 'monthly', time, dayOfMonth: r.dayOfMonth };
  return { freq: 'daily', time };
}

/** after より後で、いちばん近い回 */
export function nextOccurrence(r: Recurrence, after: Date): Date {
  const hm = parseHm(r.time) ?? { h: 0, m: 0 };
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setHours(hm.h, hm.m);
  // 最大で 1 か月と少し先まで、1 日ずつ進めて探す
  for (let i = 0; i < 40; i++) {
    const ok =
      d.getTime() > after.getTime() &&
      (r.freq === 'daily' ||
        (r.freq === 'weekly' && (r.weekdays ?? []).includes(d.getDay())) ||
        (r.freq === 'monthly' && d.getDate() === r.dayOfMonth));
    if (ok) return d;
    d.setDate(d.getDate() + 1);
    d.setHours(hm.h, hm.m, 0, 0);
  }
  return d;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** EventBridge Scheduler の式。follow-up は at()、schedule は cron()（どちらも timezone の時刻） */
export function expressionOf(kind: TimerKind, dueAt: string, r?: Recurrence): string {
  if (kind === 'followup' || !r) {
    const d = new Date(dueAt);
    return `at(${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00)`;
  }
  const hm = parseHm(r.time) ?? { h: 0, m: 0 };
  if (r.freq === 'weekly') return `cron(${hm.m} ${hm.h} ? * ${(r.weekdays ?? []).map((w) => CRON_DOW[w]).join(',')} *)`;
  if (r.freq === 'monthly') return `cron(${hm.m} ${hm.h} ${String(r.dayOfMonth)} * ? *)`;
  return `cron(${hm.m} ${hm.h} * * ? *)`;
}

/** "7:00"（先頭の 0 は付けない） */
function hmLabel(time: string): string {
  const hm = parseHm(time);
  return hm ? `${hm.h}:${pad(hm.m)}` : time;
}

/** 平日（月〜金）と週末（土日）はまとめて言う */
function weekdaysLabel(w: number[]): string {
  const s = [...w].sort((a, b) => a - b).join(',');
  if (s === '1,2,3,4,5') return '平日';
  if (s === '0,6') return '土日';
  if (w.length === 7) return '毎日';
  return [...w]
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)) // 月曜から並べる
    .map((d) => WEEK[d])
    .join('・');
}

/** "毎日 7:00" / "毎週 金曜 20:00" / "平日 7:30" / "毎月 25日 9:00" */
export function recurrenceLabel(r: Recurrence): string {
  const t = hmLabel(r.time);
  if (r.freq === 'weekly') {
    const w = r.weekdays ?? [];
    const label = weekdaysLabel(w);
    if (label === '平日' || label === '土日' || label === '毎日') return `${label} ${t}`;
    return `毎週 ${label}${w.length === 1 ? '曜' : ''} ${t}`;
  }
  if (r.freq === 'monthly') return `毎月 ${String(r.dayOfMonth)}日 ${t}`;
  return `毎日 ${t}`;
}

/** 日時を短く: "今日 19:00" / "明日 7:00" / "11月20日（金）19:00" */
export function dueLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = (x: Date) => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()) / 86_400_000;
  const diff = day(d) - day(now);
  const head = diff === 0 ? '今日' : diff === 1 ? '明日' : diff === -1 ? '昨日' : dateLabel(ymd(d));
  // 「11月20日（金）19:00」は括弧のあとに空白を入れない
  return `${head}${head.endsWith('）') ? '' : ' '}${timeLabel(iso)}`;
}

/** 次の回までの長さ: "あと 25 分" / "あと 3 時間" / "あと 2 日" */
export function untilLabel(iso: string, now = Date.now()): string {
  const min = Math.round((new Date(iso).getTime() - now) / 60_000);
  if (min <= 0) return 'まもなく';
  if (min < 60) return `あと ${String(min)} 分`;
  const h = Math.round(min / 60);
  if (h < 24) return `あと ${String(h)} 時間`;
  return `あと ${String(Math.round(h / 24))} 日`;
}

/** 一覧の並び: 動いているものは近い順、終わったものは新しい順 */
export function sortTimers(timers: Timer[]): Timer[] {
  const active = timers.filter((t) => t.status === 'active').sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const ended = timers.filter((t) => t.status !== 'active').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return [...active, ...ended];
}

export const KIND_LABEL: Record<TimerKind, string> = { followup: '1 回だけ', schedule: '繰り返し' };
