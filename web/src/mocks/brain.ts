import type { InboxEvent } from '../api/schema';
import { firstLine, summarize } from '../ui/derive';
import {
  SOURCE_LABEL,
  type Everyday,
  dateLabel,
  daysUntil,
  readEveryday,
  timeLabel,
  whenLabel,
  ymd,
  yen,
} from '../ui/payloads';
import { dueLabel } from '../ui/timers';
import { noEffects, type Effects } from './records';

/**
 * モックの「エージェント」。実際は AgentCore Runtime 上で Claude が決めることを、
 * 決まったルールで真似する。記事の「最初は静かに」に合わせ、知らせる価値がなければ何も送らない。
 *
 * 想定している使い方: 小学生の子どもがいる家庭で、学校の提出物、支払いや手続きの期限、
 * 宅配の受け取りだけを知らせてもらう。期限や時刻は、通知が届いた時点（receivedAt）から数える。
 *
 * 知らせるだけでなく、記事の memory と timers も使う（effects）:
 *   ・「〜だけ知らせて」は instructions.md に、「覚えて」は notes/ に書く
 *   ・「思い出させて」は follow-up のタイマーを作り、tasks/ に進み具合を書く
 *   ・数日先が期限の支払いは、期限の前の日の夜にもう一度知らせる follow-up を自分で作る
 *   ・タイマーで起きたら（source: scheduler）、follow-up はリマインドを送る。朝のチェックは黙っている
 * 本物のエージェント（Claude）は毎回メモリを読んで判断する。このモックはメモリの中身を読まず、決まったルールで動く。
 */
export interface BrainOutput {
  messages: { text: string; importance: 'normal' | 'high' }[];
  effects: Effects;
}

/** 知らせ方。quiet は記録だけで、何も送らない */
export type Level = 'urgent' | 'notable' | 'quiet';

const SUSPICIOUS =
  /(ignore (all )?previous|以前の指示を無視|指示を無視|system prompt|システムプロンプト|秘密鍵|全員に送信|カード番号|暗証番号)/i;

export function think(events: InboxEvent[]): BrainOutput {
  const out: BrainOutput['messages'] = [];
  const effects = noEffects();
  const userTexts: { text: string; ref: Date }[] = [];
  const urgent: string[] = [];
  const notable: string[] = [];
  const suspicious: string[] = [];
  const reminders: { title: string; note?: string }[] = [];
  const scheduled: { title: string; note?: string }[] = [];

  for (const e of events) {
    if (e.type === 'user_message') {
      userTexts.push({ text: textOf(e.payload), ref: refOf(e) });
      continue;
    }
    if (e.source === 'scheduler') {
      // タイマーで起きた。follow-up はリマインド、朝のチェックは（知らせることがなければ）黙っている
      const t = timerPayload(e.payload);
      if (!t || t.title.includes('チェック')) continue;
      (t.kind === 'followup' ? reminders : scheduled).push(t);
      continue;
    }
    if (SUSPICIOUS.test(JSON.stringify(e.payload))) {
      suspicious.push(`${SOURCE_LABEL[e.source] ?? e.source}から届いた「${summarize(e)}」`);
      continue;
    }
    const n = readEveryday(e);
    // 形のわからない通知や、朝のチェック（system）は知らせない
    if (!n) continue;
    const j = judge(n, refOf(e));
    if (j.level === 'urgent') urgent.push(j.text);
    else if (j.level === 'notable') notable.push(j.text);
    if (j.followup) effects.timers.push({ kind: 'followup', ...j.followup });
  }

  if (userTexts.length > 0) out.push({ text: replyTo(userTexts, effects), importance: 'normal' });
  if (reminders.length > 0) out.push({ text: reminderText(reminders), importance: 'normal' });
  for (const t of scheduled) {
    // 本物のエージェントは、ここで記録を読んでまとめを作る。モックは中身を作らない
    out.push({
      text: `「${t.title}」の時間です。${t.note ? `（${t.note}）` : ''}\nモックのエージェントなので、まとめの中身は作っていません。`,
      importance: 'normal',
    });
  }
  if (urgent.length > 0)
    out.push({ text: `急ぎで確認してほしいことがあります。\n${bullets(urgent)}`, importance: 'high' });
  if (notable.length > 0) out.push({ text: `お知らせです。\n${bullets(notable)}`, importance: 'normal' });
  if (suspicious.length > 0) {
    out.push({
      text: `あなたへの指示のような文（カード番号を送る、など）が含まれる通知が届いたので、従わずに保留しました。\n${bullets(suspicious)}\n本物の連絡かわからないときは、リンクを開かず、公式のアプリやサイトから確かめてください。`,
      importance: 'normal',
    });
  }
  // 1 回の run で送るのは 3 件まで（src/agent/loop.ts と同じ上限）
  return { messages: out.slice(0, 3), effects };
}

interface Judgement {
  level: Level;
  text: string;
  /** あとでもう一度知らせるために、エージェントが自分で作る follow-up */
  followup?: { title: string; note?: string; dueAt: string };
}

/** 1 件の通知をどう知らせるか。ref は通知が届いた時刻 */
export function judge(n: Everyday, ref: Date): Judgement {
  const quiet = { level: 'quiet' as const, text: '' };
  switch (n.source) {
    case 'school': {
      // 提出や持ち物の期限が 3 日以内なら知らせる。明日までなら急ぎ。期限のないお便りは記録だけ
      const { title, due, items } = n.p;
      const d = due ? daysUntil(due, ref) : undefined;
      if (!due || d === undefined || d < 0 || d > 3) return quiet;
      const what = items?.length ? `持ち物: ${items.join('、')}` : '提出があります';
      return { level: d <= 1 ? 'urgent' : 'notable', text: `学校「${title}」: ${whenLabel(due, ref)}まで。${what}` };
    }
    case 'calendar': {
      // 36 時間以内に始まる予定の追加・変更だけ知らせる
      const { action, title, start, by } = n.p;
      const hours = (Date.parse(start) - ref.getTime()) / 3_600_000;
      if (!(hours >= 0 && hours <= 36)) return quiet;
      const verb = action === 'created' ? '追加' : '変更';
      return {
        level: 'notable',
        text: `${by ?? '家族'}が予定を${verb}しました: ${whenLabel(start, ref)} ${timeLabel(start)}「${title}」`,
      };
    }
    case 'card': {
      // いつもの 1.5 倍以上の請求だけ知らせる
      const { merchant, amount, usual } = n.p;
      if (usual === undefined || amount < usual * 1.5) return quiet;
      return {
        level: 'urgent',
        text: `${merchant}の請求が ${yen(amount)}でした（いつもは ${yen(usual)}前後）。心当たりがなければカード会社に確かめてください。`,
      };
    }
    case 'bills': {
      // 期限が 7 日以内なら知らせる。2 日以内なら急ぎ
      const { kind, name, due, amount, method } = n.p;
      const d = daysUntil(due, ref);
      if (d === undefined || d < 0 || d > 7) return quiet;
      const text =
        kind === 'renewal'
          ? `${name}が${whenLabel(due, ref)}に自動で更新されます${amount !== undefined ? `（${yen(amount)}）` : ''}。続けない場合は、それまでに解約してください。`
          : `${name}${amount !== undefined ? ` ${yen(amount)}` : ''}の支払い期限が${whenLabel(due, ref)}です${method ? `（${method}）` : ''}。`;
      if (d <= 2) return { level: 'urgent', text };
      // 3 日以上先なら、期限の前の日の 19 時にもう一度知らせる
      const eve = dayBefore(due, 19);
      return {
        level: 'notable',
        text: `${text}前の日の夜にもう一度お知らせします。`,
        followup:
          eve === undefined
            ? undefined
            : {
                // 題名は「何の期限か」。一覧で、まだ先なのに「明日」と見えないようにする
                title:
                  kind === 'renewal'
                    ? `${name}の自動更新（${dateLabel(due)}）`
                    : `${name}の支払い期限（${dateLabel(due)}）`,
                note: [amount !== undefined ? yen(amount) : undefined, method].filter(Boolean).join('、') || undefined,
                dueAt: eve,
              },
      };
    }
    case 'delivery': {
      // 不在は急ぎ、今日届くものは知らせる。発送・配達完了は記録だけ
      const { carrier, status, item, window, deadline } = n.p;
      const what = item ? `（${item}）` : '';
      if (status === 'absent')
        return {
          level: 'urgent',
          text: `${carrier}: 不在で持ち帰りになりました${what}。${deadline ? `今日の再配達の受付は ${deadline} まで。` : '再配達の手配が必要です。'}`,
        };
      if (status === 'out_for_delivery')
        return { level: 'notable', text: `${carrier}: ${window ? `今日の${window}に` : '今日'}届きます${what}。` };
      return quiet;
    }
    case 'shop': {
      // 定期便の変更締切が 2 日以内なら知らせる。注文の受付は記録だけ
      const { kind, shop, item, due } = n.p;
      const d = due ? daysUntil(due, ref) : undefined;
      if (kind !== 'skip_deadline' || !due || d === undefined || d < 0 || d > 2) return quiet;
      return { level: 'notable', text: `${shop}: 定期便（${item}）の変更・お休みの締切が${whenLabel(due, ref)}です。` };
    }
  }
}

function refOf(e: InboxEvent): Date {
  const t = Date.parse(e.receivedAt);
  return Number.isNaN(t) ? new Date() : new Date(t);
}

function textOf(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null && 'text' in payload) {
    const t = payload.text;
    if (typeof t === 'string') return t;
  }
  return JSON.stringify(payload);
}

function replyTo(items: { text: string; ref: Date }[], effects: Effects): string {
  const all = items.map((i) => i.text).join('\n');
  const last = items.at(-1) ?? { text: all, ref: new Date() };
  const head = items.length > 1 ? `${items.length} 件まとめて受け取りました。` : '';
  if (/(思い出させて|リマインド|忘れないように)/.test(all)) {
    const due = parseWhen(last.text, last.ref);
    const title = `${subjectOf(last.text)}のこと`;
    const file = `reminder-${ymd(due).replaceAll('-', '')}-${String(due.getHours()).padStart(2, '0')}${String(due.getMinutes()).padStart(2, '0')}.md`;
    effects.timers.push({
      kind: 'followup',
      title,
      note: `「${firstLine(last.text, 60)}」と頼まれた`,
      dueAt: due.toISOString(),
    });
    effects.memory.push(
      {
        path: `tasks/${file}`,
        content: `# ${title}\n\n- 頼まれた日: ${dateLabel(ymd(last.ref))}\n- 元のお願い: 「${firstLine(last.text, 120)}」\n- 次の一手: ${dueLabel(due.toISOString(), last.ref)} に知らせる（タイマー）\n`,
      },
      {
        path: 'tasks/index.md',
        header: '# 続いているタスク\n\n',
        append: `- [${title}](${file}): ${dueLabel(due.toISOString(), last.ref)} に知らせる`,
      },
    );
    return `${head}承知しました。${dueLabel(due.toISOString(), last.ref)}にお知らせするタイマーを設定し、tasks/ にも書いておきました。時刻はタイマーの画面で変えられます。`;
  }
  if (/(知らせ|通知|教えて)/.test(all) && /(だけ|のみ|ください|大丈夫|不要|いらない)/.test(all)) {
    for (const i of items)
      effects.memory.push({
        path: 'instructions.md',
        header: '# あなたからの指示\n\n',
        append: `- ${firstLine(i.text, 200)}`,
      });
    return `${head}わかりました。memory/instructions.md に書いておきます。これからは、期限が近いもの、受け取りが必要なもの、いつもと違うものだけを知らせ、それ以外は黙って記録しておきます。`;
  }
  if (/(覚えて|メモして)/.test(all)) {
    const file = `memo-${ymd(last.ref).replaceAll('-', '')}-${String(last.ref.getHours()).padStart(2, '0')}${String(last.ref.getMinutes()).padStart(2, '0')}.md`;
    effects.memory.push(
      { path: `notes/${file}`, content: `# メモ（${dateLabel(ymd(last.ref))}）\n\n${all}\n` },
      { path: 'notes/index.md', header: '# あなたについてのメモ\n\n', append: `- [${firstLine(all, 24)}](${file})` },
    );
    return `${head}memory/notes/ に書いておきました。次からはこれを前提にします。`;
  }
  if (/(ありがとう|助かり)/.test(all)) return `${head}どういたしまして。ほかにも気になることがあれば送ってください。`;
  if (/[?？]$/.test(all.trim())) {
    return `${head}確認しました。手元の記録（memory と直近の通知）からわかる範囲では、まだ判断できる材料が少ないです。関係する通知が届いたら、まとめてお知らせします。`;
  }
  const quoted = all.length > 40 ? `${all.slice(0, 40)}…` : all;
  return `${head}「${quoted}」を受け取りました。覚えておく必要があるものは memory に残しておきます。`;
}

const bullets = (lines: string[]) => lines.map((l) => `・${l}`).join('\n');

function reminderText(items: { title: string; note?: string }[]): string {
  const only = items.length === 1 ? items.at(0) : undefined;
  if (only) return `リマインドです。${only.title}。${only.note ? `\n${only.note}` : ''}`;
  return `リマインドです。\n${bullets(items.map((t) => (t.note ? `${t.title}（${t.note}）` : t.title)))}`;
}

function timerPayload(p: unknown): { kind: 'followup' | 'schedule'; title: string; note?: string } | undefined {
  if (typeof p !== 'object' || p === null) return undefined;
  const r = p as Record<string, unknown>;
  if ((r.kind !== 'followup' && r.kind !== 'schedule') || typeof r.title !== 'string') return undefined;
  return { kind: r.kind, title: r.title, note: typeof r.note === 'string' && r.note !== '' ? r.note : undefined };
}

/** "YYYY-MM-DD" の前の日の hour 時（ISO 8601） */
function dayBefore(s: string, hour: number): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return undefined;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1, hour).toISOString();
}

/**
 * 「思い出させて」のいつ。本物のエージェントは文から読み取る。ここでは、よくある言い方だけを読む:
 * 「N分後」「N時間後」「明日」「あさって」「N日後」「来週」「M月D日」「M月…1か月前」。時刻は「N時」、なければ 9 時。
 * どれでもなければ 3 日後の 9 時
 */
export function parseWhen(text: string, ref: Date): Date {
  const t = text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const mins = /(\d+)\s*分後/.exec(t);
  if (mins) return new Date(ref.getTime() + Number(mins[1]) * 60_000);
  const hours = /(\d+)\s*時間後/.exec(t);
  if (hours) return new Date(ref.getTime() + Number(hours[1]) * 3_600_000);
  const hourOf = /(\d{1,2})\s*時(?!間)/.exec(t);
  const hour = hourOf && Number(hourOf[1]) <= 23 ? Number(hourOf[1]) : 9;
  const day = (y: number, mo: number, d: number) => new Date(y, mo, d, hour);
  const y = ref.getFullYear();
  const later = (d: Date) =>
    d.getTime() > ref.getTime() ? d : new Date(d.getFullYear() + 1, d.getMonth(), d.getDate(), hour);

  const md = /(\d{1,2})月(\d{1,2})日/.exec(t);
  if (md) return later(day(y, Number(md[1]) - 1, Number(md[2])));
  const month = /(\d{1,2})月/.exec(t);
  if (month) {
    // 「1月なので、1か月前」→ 前の月の 1 日
    const before = /(\d+)\s*(か月|ヶ月|カ月)前/.exec(t);
    const mo = Number(month[1]) - 1 - (before ? Number(before[1]) : 0);
    return later(day(y, mo, 1));
  }
  const days = /(\d+)\s*日後/.exec(t);
  const offset = days
    ? Number(days[1])
    : t.includes('あさって')
      ? 2
      : t.includes('明日')
        ? 1
        : t.includes('来週')
          ? 7
          : 3;
  return day(y, ref.getMonth(), ref.getDate() + offset);
}

/**
 * お願いの主題。「車検が1月なので…」→「車検」、「2分後に、洗濯物を取り込むよう…」→「洗濯物」。
 * お礼と時刻の言い方を除いてから、最初の「が・は・を・の・に」の前を取る。読めなければ文の頭
 */
export function subjectOf(text: string): string {
  const body = text
    .replace(/^(ありがとう|助かります|お願いします)[。、！!]*/, '')
    .replace(/(\d+\s*(分|時間|日)後|明日|あさって|来週|\d{1,2}月\d{1,2}日|\d{1,2}\s*時)(の|に|、)*/g, '')
    .replace(/^[、。\s]+/, '')
    .trim();
  const m = /^([^、。\s]{1,16}?)(が|は|を|の|に)/.exec(body);
  return m?.[1] ?? firstLine(body, 16);
}
