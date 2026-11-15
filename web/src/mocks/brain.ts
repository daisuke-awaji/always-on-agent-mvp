import type { InboxEvent } from '../api/schema';
import { summarize } from '../ui/derive';
import { SOURCE_LABEL, type Everyday, daysUntil, readEveryday, timeLabel, whenLabel, yen } from '../ui/payloads';

/**
 * モックの「エージェント」。実際は AgentCore Runtime 上で Claude が決めることを、
 * 決まったルールで真似する。記事の「最初は静かに」に合わせ、知らせる価値がなければ何も送らない。
 *
 * 想定している使い方: 小学生の子どもがいる家庭で、学校の提出物、支払いや手続きの期限、
 * 宅配の受け取りだけを知らせてもらう。期限や時刻は、通知が届いた時点（receivedAt）から数える。
 */
export interface BrainOutput {
  messages: { text: string; importance: 'normal' | 'high' }[];
}

/** 知らせ方。quiet は記録だけで、何も送らない */
export type Level = 'urgent' | 'notable' | 'quiet';

const SUSPICIOUS =
  /(ignore (all )?previous|以前の指示を無視|指示を無視|system prompt|システムプロンプト|秘密鍵|全員に送信|カード番号|暗証番号)/i;

export function think(events: InboxEvent[]): BrainOutput {
  const out: BrainOutput['messages'] = [];
  const userTexts: string[] = [];
  const urgent: string[] = [];
  const notable: string[] = [];
  const suspicious: string[] = [];

  for (const e of events) {
    if (e.type === 'user_message') {
      userTexts.push(textOf(e.payload));
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
  }

  if (userTexts.length > 0) out.push({ text: replyTo(userTexts), importance: 'normal' });
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
  return { messages: out.slice(0, 3) };
}

/** 1 件の通知をどう知らせるか。ref は通知が届いた時刻 */
export function judge(n: Everyday, ref: Date): { level: Level; text: string } {
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
      return { level: d <= 2 ? 'urgent' : 'notable', text };
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

function replyTo(texts: string[]): string {
  const all = texts.join('\n');
  const head = texts.length > 1 ? `${texts.length} 件まとめて受け取りました。` : '';
  if (/(思い出させて|リマインド|忘れないように|追って|見ておいて)/.test(all)) {
    return `${head}承知しました。tasks/ にタスクとして登録しました。関係する通知が届いたときと、朝のチェックで近づいてきたときに知らせます。`;
  }
  if (/(知らせ|通知|教えて)/.test(all) && /(だけ|のみ|ください|大丈夫|不要|いらない)/.test(all)) {
    return `${head}わかりました。memory/instructions.md に書いておきます。これからは、期限が近いもの、受け取りが必要なもの、いつもと違うものだけを知らせ、それ以外は黙って記録しておきます。`;
  }
  if (/(覚えて|メモして)/.test(all)) return `${head}memory/notes/ に書いておきました。次からはこれを前提にします。`;
  if (/(ありがとう|助かり)/.test(all)) return `${head}どういたしまして。ほかにも気になることがあれば送ってください。`;
  if (/[?？]$/.test(all.trim())) {
    return `${head}確認しました。手元の記録（memory と直近の通知）からわかる範囲では、まだ判断できる材料が少ないです。関係する通知が届いたら、まとめてお知らせします。`;
  }
  const quoted = all.length > 40 ? `${all.slice(0, 40)}…` : all;
  return `${head}「${quoted}」を受け取りました。覚えておく必要があるものは memory に残しておきます。`;
}

const bullets = (lines: string[]) => lines.map((l) => `・${l}`).join('\n');
