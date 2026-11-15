import type { ContentBlock, Message } from '@aws-sdk/client-bedrock-runtime';

/**
 * Converse API は user / assistant が交互に並ぶ必要がある。
 * 前の run がツール結果（user）で終わっていた場合は、そこに新しいイベントを足す。
 */
export function appendUserContent(messages: Message[], content: ContentBlock[]): Message[] {
  const last = messages.at(-1);
  if (last?.role === 'user') {
    return [...messages.slice(0, -1), { role: 'user', content: [...(last.content ?? []), ...content] }];
  }
  return [...messages, { role: 'user', content }];
}

const isPlainUserTurn = (m: Message) =>
  m.role === 'user' && !(m.content ?? []).some((c) => 'toolResult' in c && c.toolResult);

/**
 * session が長くなりすぎたら古いメッセージを落とす（記事: "start a new session" / "compact"）。
 * toolUse と toolResult の対を壊さないよう、ツール結果を含まない user ターンの位置で切る。
 * 落ちた内容は戻らないので、残すべきことは run の中でメモリに書かせる。
 */
export function trimHistory(messages: Message[], opts: { maxMessages: number; maxChars: number }): Message[] {
  const size = (ms: Message[]) => JSON.stringify(ms).length;
  if (messages.length <= opts.maxMessages && size(messages) <= opts.maxChars) return messages;
  for (let i = 1; i < messages.length; i++) {
    if (!isPlainUserTurn(messages[i])) continue;
    const rest = messages.slice(i);
    if (rest.length <= opts.maxMessages && size(rest) <= opts.maxChars) return rest;
  }
  return [];
}

/**
 * 送信用のコピーを作り、最後のメッセージにキャッシュポイントを付ける。
 * 1 回の run の中でツールを何度も呼ぶとき、それまでの履歴をキャッシュから読めるようにする。
 * 保存する履歴には cachePoint を残さない。
 */
export function withTrailingCachePoint(messages: Message[]): Message[] {
  const last = messages.at(-1);
  if (!last) return messages;
  return [
    ...messages.slice(0, -1),
    { ...last, content: [...(last.content ?? []), { cachePoint: { type: 'default' } }] },
  ];
}
