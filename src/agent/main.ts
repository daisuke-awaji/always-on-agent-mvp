import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoMessageRepository } from '../shared/message-repo.js';
import { isValidSessionId, isValidUserId, type RunRequest } from '../shared/types.js';
import { runAgent, type AgentDeps } from './loop.js';
import { AwsSender, LocalSender } from './sender.js';
import { LocalFileStore, S3FileStore, SessionStore } from './stores.js';

/**
 * AgentCore Runtime の HTTP 契約:
 *   GET  /ping         ヘルスチェック。run 中は HealthyBusy を返し、アイドル扱いで止められないようにする
 *   POST /invocations  1 回の run（RunRequest → RunResult）
 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function createAgentServer(deps: AgentDeps): Server {
  let busy = 0;
  let lastUpdate = Math.floor(Date.now() / 1000);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method === 'GET' && req.url === '/ping') {
        send(res, 200, { status: busy > 0 ? 'HealthyBusy' : 'Healthy', time_of_last_update: lastUpdate }); return;
      }
      if (req.method === 'POST' && req.url?.startsWith('/invocations')) {
        const body = await readBody(req);
        const runReq = validateRunRequest(JSON.parse(body));
        busy++;
        lastUpdate = Math.floor(Date.now() / 1000);
        try {
          const result = await runAgent(runReq, deps);
          send(res, 200, result); return;
        } finally {
          busy--;
          lastUpdate = Math.floor(Date.now() / 1000);
        }
      }
      send(res, 404, { error: 'not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ msg: 'invocation failed', error: message }));
      send(res, err instanceof ValidationError ? 400 : 500, { error: message });
    }
  };

  return createServer((req, res) => {
    // handle 内で例外は処理済み。ここに来るのは応答の送信自体に失敗したときだけ
    handle(req, res).catch((err: unknown) => {
      console.error(JSON.stringify({ msg: 'failed to send response', error: err instanceof Error ? err.message : String(err) }));
      res.destroy();
    });
  });
}

class ValidationError extends Error {}

export function validateRunRequest(v: unknown): RunRequest {
  if (typeof v !== 'object' || v === null) throw new ValidationError('body must be an object');
  const r = v as Partial<RunRequest>;
  if (typeof r.runId !== 'string' || !r.runId) throw new ValidationError('runId is required');
  if (!isValidUserId(r.userId)) throw new ValidationError('invalid userId');
  if (!isValidSessionId(r.sessionId)) throw new ValidationError('invalid sessionId');
  if (!Array.isArray(r.events) || r.events.length === 0) throw new ValidationError('events must be a non-empty array');
  return { ...r, recentMessages: Array.isArray(r.recentMessages) ? r.recentMessages : [] } as RunRequest;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ValidationError('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => { resolveBody(Buffer.concat(chunks).toString('utf-8')); });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** 環境変数から本番（AWS）またはローカルの依存を組み立てる */
export function depsFromEnv(env = process.env): AgentDeps {
  const bedrock = new BedrockRuntimeClient({});
  const modelId = env.MODEL_ID ?? 'jp.anthropic.claude-sonnet-4-6';
  const log = (msg: string, data?: Record<string, unknown>) => { console.log(JSON.stringify({ msg, ...data })); };
  const converse: AgentDeps['converse'] = (input) => bedrock.send(new ConverseCommand(input));

  if (env.STORE === 'local') {
    const root = resolve(env.LOCAL_STATE_DIR ?? '.local-state');
    const files = new LocalFileStore(root);
    return { converse, files, sessions: new SessionStore(files), sender: new LocalSender(root), modelId, log };
  }
  const bucket = env.STATE_BUCKET;
  const table = env.MESSAGES_TABLE;
  if (!bucket || !table) throw new Error('STATE_BUCKET and MESSAGES_TABLE are required');
  const files = new S3FileStore(bucket);
  return {
    converse,
    files,
    sessions: new SessionStore(files),
    sender: new AwsSender(new DynamoMessageRepository(table), env.NOTIFY_TOPIC_ARN || undefined),
    modelId,
    log,
  };
}

// エントリーポイントとして実行されたときだけ起動する（テストからの import では起動しない）
const isEntrypoint = process.argv[1] && /main\.(ts|js|mjs|cjs)$/.test(process.argv[1]);
if (isEntrypoint) {
  const port = Number(process.env.PORT ?? 8080);
  createAgentServer(depsFromEnv()).listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({ msg: 'agent listening', port, store: process.env.STORE ?? 's3' }));
  });
}
