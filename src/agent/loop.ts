import type {
  ContentBlock,
  ConverseCommandInput,
  ConverseCommandOutput,
  Message,
  Tool,
  ToolResultContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import type { RunRequest, RunResult } from '../shared/types.js';
import { appendUserContent, trimHistory, withTrailingCachePoint } from './history.js';
import { AUTOLOAD_FILES, MemoryStore, type MemoryToolInput } from './memory.js';
import { STATIC_SYSTEM_PROMPT, buildDynamicContext, formatEvents } from './prompt.js';
import type { Sender } from './sender.js';
import type { FileStore, SessionRecord, SessionStore } from './stores.js';

export type ConverseFn = (
  input: ConverseCommandInput,
) => Promise<Pick<ConverseCommandOutput, 'output' | 'stopReason' | 'usage'>>;

export interface AgentDeps {
  converse: ConverseFn;
  files: FileStore;
  sessions: SessionStore;
  sender: Sender;
  modelId: string;
  now?: () => Date;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export const AGENT_LIMITS = {
  maxTurns: 12,
  maxSendsPerRun: 3,
  maxMessageChars: 2000,
  maxTokens: 4096,
  history: { maxMessages: 80, maxChars: 300_000 },
};

export const TOOLS: Tool[] = [
  {
    toolSpec: {
      name: 'memory',
      description:
        'ユーザーごとの永続メモリ（Markdown ファイル）を操作する。run をまたいで残したいことはここに書く。' +
        'command: view（ファイルの中身、またはディレクトリの一覧。path を空にするとルート）, create（新規作成・上書き）, ' +
        'str_replace（old_str を new_str に置換。old_str はファイル内で 1 回だけ出現すること）, delete（削除）。' +
        'path の例: instructions.md, notes/index.md, notes/role.md, tasks/index.md, tasks/<task-id>.md',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            command: { type: 'string', enum: ['view', 'create', 'str_replace', 'delete'] },
            path: { type: 'string', description: 'メモリのルートからの相対パス' },
            file_text: { type: 'string', description: 'create のときのファイル全体の内容' },
            old_str: { type: 'string', description: 'str_replace で置き換える文字列' },
            new_str: { type: 'string', description: 'str_replace の置換後の文字列' },
          },
          required: ['command', 'path'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'send_message',
      description:
        'ユーザーにメッセージを届ける。ユーザーに届くのはこのツールで送った内容だけ。' +
        `1 回の run で送れるのは ${AGENT_LIMITS.maxSendsPerRun} 通まで。知らせる必要がなければ呼ばない。`,
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: `ユーザーに届ける本文（${AGENT_LIMITS.maxMessageChars} 文字以内）。結論から短く。`,
            },
            importance: { type: 'string', enum: ['normal', 'high'], description: 'すぐ見てほしいときだけ high' },
          },
          required: ['text'],
        },
      },
    },
  },
];

export async function runAgent(req: RunRequest, deps: AgentDeps): Promise<RunResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const memory = new MemoryStore(deps.files, req.userId);

  // 1. session を読み込む（なければ新規）
  const existing = await deps.sessions.load(req.userId, req.sessionId);
  const session: SessionRecord = existing ?? {
    sessionId: req.sessionId,
    userId: req.userId,
    createdAt: now().toISOString(),
    updatedAt: now().toISOString(),
    runs: 0,
    messages: [],
  };

  // 2. 毎回の文脈: 指示とメモリの index、直近の送信
  const [autoloaded, fileList] = await Promise.all([
    Promise.all(AUTOLOAD_FILES.map(async (path) => ({ path, content: await memory.read(path) }))),
    memory.listAll(),
  ]);
  const system: ConverseCommandInput['system'] = [
    { text: STATIC_SYSTEM_PROMPT },
    { cachePoint: { type: 'default' } },
    {
      text: buildDynamicContext({
        now: now(),
        userId: req.userId,
        sessionId: req.sessionId,
        resumed: !!existing,
        autoloaded,
        fileList,
        recentMessages: req.recentMessages,
      }),
    },
  ];

  // 3. 届いたイベントを user ターンとして追加
  let messages = trimHistory(session.messages, AGENT_LIMITS.history);
  messages = appendUserContent(messages, [{ text: formatEvents(req.events) }]);

  // 4. エージェントループ
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
  let sends = 0;
  let turns = 0;
  let stopReason = 'unknown';

  while (turns < AGENT_LIMITS.maxTurns) {
    turns++;
    const out = await deps.converse({
      modelId: deps.modelId,
      system,
      messages: withTrailingCachePoint(messages),
      toolConfig: { tools: TOOLS },
      inferenceConfig: { maxTokens: AGENT_LIMITS.maxTokens },
    });
    usage.inputTokens += out.usage?.inputTokens ?? 0;
    usage.outputTokens += out.usage?.outputTokens ?? 0;
    usage.cacheReadInputTokens += out.usage?.cacheReadInputTokens ?? 0;
    usage.cacheWriteInputTokens += out.usage?.cacheWriteInputTokens ?? 0;
    stopReason = out.stopReason ?? 'unknown';

    const assistant = out.output?.message;
    if (!assistant) throw new Error('model returned no message');
    messages = [...messages, { role: 'assistant', content: assistant.content ?? [] }];

    const toolUses = (assistant.content ?? []).flatMap((c) => (c.toolUse ? [c.toolUse] : []));
    if (stopReason !== 'tool_use' || toolUses.length === 0) break;

    const results: ContentBlock[] = [];
    for (const tu of toolUses) {
      const input = (tu.input ?? {}) as Record<string, unknown>;
      let content: ToolResultContentBlock[];
      let status: 'success' | 'error' = 'success';
      try {
        if (tu.name === 'memory') {
          content = [{ text: await memory.execute(input as unknown as MemoryToolInput) }];
        } else if (tu.name === 'send_message') {
          const text = typeof input.text === 'string' ? input.text.trim() : '';
          if (!text) throw new Error('text is required');
          if (text.length > AGENT_LIMITS.maxMessageChars)
            throw new Error(`text must be <= ${AGENT_LIMITS.maxMessageChars} chars`);
          if (sends >= AGENT_LIMITS.maxSendsPerRun) {
            throw new Error(
              `この run ではもう送れません（上限 ${AGENT_LIMITS.maxSendsPerRun} 通）。必要なら内容をまとめてください`,
            );
          }
          const importance = input.importance === 'high' ? 'high' : 'normal';
          const { messageId } = await deps.sender.send({
            userId: req.userId,
            sessionId: req.sessionId,
            runId: req.runId,
            text,
            importance,
          });
          sends++;
          content = [{ text: `sent (messageId=${messageId})` }];
        } else {
          throw new Error(`unknown tool: ${tu.name ?? '(none)'}`);
        }
      } catch (err) {
        status = 'error';
        content = [{ text: err instanceof Error ? err.message : String(err) }];
      }
      log('tool', { runId: req.runId, tool: tu.name, command: input.command, path: input.path, status });
      results.push({ toolResult: { toolUseId: tu.toolUseId, content, status } });
    }
    messages = [...messages, { role: 'user', content: results }];

    if (turns >= AGENT_LIMITS.maxTurns) {
      stopReason = 'max_turns';
      log('max turns reached', { runId: req.runId });
    }
  }

  // 5. session を保存（次の run がここから再開できる）
  await deps.sessions.save({ ...session, messages, runs: session.runs + 1, updatedAt: now().toISOString() });

  return {
    runId: req.runId,
    sessionId: req.sessionId,
    outcome: sends > 0 ? 'sent' : 'silent',
    messagesSent: sends,
    turns,
    stopReason,
    usage,
  };
}

/** 保存済み session の最後のアシスタント発話（run の内部サマリ）を取り出す。デバッグ用 */
export function lastAssistantText(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const text = (m.content ?? []).flatMap((c) => (c.text ? [c.text] : [])).join('\n');
    if (text) return text;
  }
  return undefined;
}
