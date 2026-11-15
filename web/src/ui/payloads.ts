import type { InboxEvent } from '../api/schema';

/**
 * モックで使う日常の通知（Webhook）の形。API の payload は自由な JSON なので、
 * 送信元（source）ごとに形を決めて、画面の文言（derive.ts）とモックのエージェント（brain.ts）が同じ読み方をする。
 *
 *   school    学校連絡アプリのお知らせ。提出や持ち物の期限（due）があることがある
 *   calendar  家族カレンダーの予定の追加・変更
 *   card      カードの利用通知。いつもの金額（usual）がわかるものだけ持つ
 *   bills     請求と手続き（払込票、サブスクの更新など）
 *   delivery  配送の状況（発送、今日届く、不在、配達完了）
 *   shop      通販（注文の受付、定期便の変更締切）
 *
 * 日付は端末の日付で "YYYY-MM-DD"、時刻つきのものは ISO 8601。
 */

export interface SchoolNotice {
  title: string;
  body?: string;
  due?: string;
  items?: string[];
}
export interface CalendarChange {
  action: 'created' | 'updated';
  title: string;
  start: string;
  by?: string;
}
export interface CardCharge {
  merchant: string;
  amount: number;
  usual?: number;
}
export interface Bill {
  kind: 'bill' | 'renewal';
  name: string;
  due: string;
  amount?: number;
  method?: string;
}
export type DeliveryStatus = 'shipped' | 'out_for_delivery' | 'absent' | 'delivered';
export interface Delivery {
  carrier: string;
  status: DeliveryStatus;
  item?: string;
  window?: string;
  deadline?: string;
  note?: string;
}
export interface ShopNotice {
  kind: 'order' | 'skip_deadline';
  shop: string;
  item: string;
  due?: string;
}

export type Everyday =
  | { source: 'school'; p: SchoolNotice }
  | { source: 'calendar'; p: CalendarChange }
  | { source: 'card'; p: CardCharge }
  | { source: 'bills'; p: Bill }
  | { source: 'delivery'; p: Delivery }
  | { source: 'shop'; p: ShopNotice };

export const SOURCE_LABEL: Record<string, string> = {
  user: 'あなた',
  school: '学校連絡',
  calendar: '家族カレンダー',
  card: 'カード',
  bills: '請求・手続き',
  delivery: '配送',
  shop: '通販',
  scheduler: 'スケジューラ',
};

export const DELIVERY_LABEL: Record<DeliveryStatus, string> = {
  shipped: '発送しました',
  out_for_delivery: '今日お届け予定',
  absent: '不在のお知らせ',
  delivered: '配達しました',
};

// ---- payload を読む（形が違えば undefined） ----

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const strs = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : undefined);
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T | undefined => values.find((x) => x === v);

/** 日常の通知として読めれば、送信元ごとの形にして返す */
export function readEveryday(e: Pick<InboxEvent, 'source' | 'payload'>): Everyday | undefined {
  const p = rec(e.payload);
  if (!p) return undefined;
  switch (e.source) {
    case 'school': {
      const title = str(p.title);
      return title
        ? { source: 'school', p: { title, body: str(p.body), due: str(p.due), items: strs(p.items) } }
        : undefined;
    }
    case 'calendar': {
      const action = oneOf(p.action, ['created', 'updated'] as const);
      const title = str(p.title);
      const start = str(p.start);
      return action && title && start ? { source: 'calendar', p: { action, title, start, by: str(p.by) } } : undefined;
    }
    case 'card': {
      const merchant = str(p.merchant);
      const amount = num(p.amount);
      return merchant && amount !== undefined
        ? { source: 'card', p: { merchant, amount, usual: num(p.usual) } }
        : undefined;
    }
    case 'bills': {
      const kind = oneOf(p.kind, ['bill', 'renewal'] as const);
      const name = str(p.name);
      const due = str(p.due);
      return kind && name && due
        ? { source: 'bills', p: { kind, name, due, amount: num(p.amount), method: str(p.method) } }
        : undefined;
    }
    case 'delivery': {
      const carrier = str(p.carrier);
      const status = oneOf(p.status, ['shipped', 'out_for_delivery', 'absent', 'delivered'] as const);
      return carrier && status
        ? {
            source: 'delivery',
            p: {
              carrier,
              status,
              item: str(p.item),
              window: str(p.window),
              deadline: str(p.deadline),
              note: str(p.note),
            },
          }
        : undefined;
    }
    case 'shop': {
      const kind = oneOf(p.kind, ['order', 'skip_deadline'] as const);
      const shop = str(p.shop);
      const item = str(p.item);
      return kind && shop && item ? { source: 'shop', p: { kind, shop, item, due: str(p.due) } } : undefined;
    }
    default:
      return undefined;
  }
}

// ---- 日付と金額 ----

/** 端末の日付で "YYYY-MM-DD" */
export function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseYmd(s: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined;
}

/** ref の日から見て、日付 s が何日後か（同じ日なら 0、過ぎていれば負）。読めなければ undefined */
export function daysUntil(s: string, ref: Date): number | undefined {
  const d = parseYmd(s) ?? (Number.isNaN(Date.parse(s)) ? undefined : new Date(s));
  if (!d) return undefined;
  const day = (x: Date) => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()) / 86_400_000;
  return day(d) - day(ref);
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

/** "11月17日（月）" */
export function dateLabel(s: string): string {
  const d = parseYmd(s) ?? new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return `${d.getMonth() + 1}月${d.getDate()}日（${WEEK[d.getDay()]}）`;
}

const NEAR = ['今日', '明日', 'あさって'];

/** ref から近ければ "明日の11月17日（火）"、3 日以上先や過ぎた日は "11月20日（金）" */
export function whenLabel(s: string, ref: Date): string {
  const d = daysUntil(s, ref);
  const near = d === undefined ? undefined : NEAR[d];
  return near ? `${near}の${dateLabel(s)}` : dateLabel(s);
}

/** "18:30" */
export function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const yen = (n: number) => `${n.toLocaleString('ja-JP')} 円`;
