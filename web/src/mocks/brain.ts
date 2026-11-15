import type { InboxEvent } from '../api/schema';

/**
 * モックの「エージェント」。実際は AgentCore Runtime 上で Claude が決めることを、
 * 決まったルールで真似する。記事の「最初は静かに」に合わせ、知らせる価値がなければ何も送らない。
 */
export interface BrainOutput {
  messages: { text: string; importance: 'normal' | 'high' }[];
}

const SUSPICIOUS = /(ignore (all )?previous|以前の指示を無視|指示を無視|system prompt|秘密鍵|全員に送信)/i;

export function think(events: InboxEvent[]): BrainOutput {
  const out: BrainOutput['messages'] = [];
  const userTexts: string[] = [];
  const notable: string[] = [];
  const urgent: string[] = [];
  const suspicious: string[] = [];

  for (const e of events) {
    const payloadText = JSON.stringify(e.payload);
    if (SUSPICIOUS.test(payloadText) && e.type !== 'user_message') {
      suspicious.push(`${e.source} から届いた通知（${e.sourceEventId ?? e.eventId.slice(0, 8)}）`);
      continue;
    }
    if (e.type === 'user_message') {
      userTexts.push(textOf(e.payload));
      continue;
    }
    const gh = githubSummary(e.payload);
    if (gh) {
      if (gh.urgent) urgent.push(gh.text);
      else if (gh.watched) notable.push(gh.text);
      continue;
    }
    // そのほかの通知（system、未知の送信元）は知らせない
  }

  if (userTexts.length > 0) out.push({ text: replyTo(userTexts), importance: 'normal' });
  if (urgent.length > 0)
    out.push({ text: `急ぎで確認してほしいものがあります。\n${bullets(urgent)}`, importance: 'high' });
  if (notable.length > 0)
    out.push({ text: `担当のリポジトリに動きがありました。\n${bullets(notable)}`, importance: 'normal' });
  if (suspicious.length > 0) {
    out.push({
      text: `あなたへの指示のような文が含まれる通知が届いたので、従わずに保留しました。\n${bullets(suspicious)}\n心当たりがなければ、送信元の設定を確認してください。`,
      importance: 'normal',
    });
  }
  // 1 回の run で送るのは 3 件まで（src/agent/loop.ts と同じ上限）
  return { messages: out.slice(0, 3) };
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
  if (/(だけ|のみ).*(知らせ|通知)|(通知|知らせ).*(だけ|のみ)/.test(all)) {
    return `${head}わかりました。指示として memory/instructions.md に書いておきます。これからは、指定されたもの以外の通知は黙って記録だけにします。`;
  }
  if (/(追って|見ておいて|進捗|追跡|管理)/.test(all)) {
    return `${head}承知しました。tasks/ にタスクとして登録しました。動きがあったときと、止まっているように見えるときに知らせます。`;
  }
  if (/(ありがとう|助かり)/.test(all)) return `${head}どういたしまして。ほかにも気になることがあれば送ってください。`;
  if (/[?？]$/.test(all.trim())) {
    return `${head}確認しました。手元の記録（memory と直近の通知）からわかる範囲では、まだ判断できる材料が少ないです。関係する通知が届いたら、まとめてお知らせします。`;
  }
  const quoted = all.length > 40 ? `${all.slice(0, 40)}…` : all;
  return `${head}「${quoted}」を受け取りました。覚えておく必要があるものは memory に残しておきます。`;
}

interface GithubSummary {
  text: string;
  watched: boolean;
  urgent: boolean;
}

/** GitHub の Webhook っぽい payload を要約する。dmp-procurement だけを見ているという設定 */
function githubSummary(payload: unknown): GithubSummary | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  const repo = typeof p.repository === 'string' ? p.repository : undefined;
  if (!repo) return undefined;
  const action = typeof p.action === 'string' ? p.action : 'updated';
  const pr = p.pull_request as { number?: unknown; title?: unknown } | undefined;
  const num = typeof pr?.number === 'number' ? ` #${pr.number}` : '';
  const title = typeof pr?.title === 'string' ? `「${pr.title}」` : '';
  const watched = repo === 'dmp-procurement';
  const label: Record<string, string> = {
    review_requested: 'レビュー依頼',
    opened: '作成',
    closed: 'クローズ',
    merged: 'マージ',
    synchronize: '更新',
    failure: 'CI 失敗',
  };
  return {
    text: `${repo}${num}${title}: ${label[action] ?? action}`,
    watched,
    urgent: watched && (action === 'review_requested' || action === 'failure'),
  };
}

const bullets = (lines: string[]) => lines.map((l) => `・${l}`).join('\n');
