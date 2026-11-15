import { randomUUID } from 'node:crypto';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { Context, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { DynamoInboxRepository } from '../shared/inbox-repo.js';
import { DynamoMessageRepository } from '../shared/message-repo.js';
import { isValidUserId, type RunRequest, type RunResult, type WakeMessage } from '../shared/types.js';
import { processUser, type WorkerDeps } from './worker-core.js';

/** 1 回の run（AgentCore Runtime 呼び出し）の待ち時間上限 */
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? 12 * 60_000);
/** これより残り時間が少なければ新しい run を始めず次回に回す */
const MIN_REMAINING_TO_START_MS = RUN_TIMEOUT_MS + 30_000;
/** Lambda のタイムアウト（15 分）より長くする。異常終了時はこの期限が来るまで他の worker は入らない */
const LEASE_MS = Number(process.env.LEASE_MS ?? 16 * 60_000);

let clients:
  | {
      agentcore: BedrockAgentCoreClient;
      sqs: SQSClient;
      inbox: DynamoInboxRepository;
      messages: DynamoMessageRepository;
    }
  | undefined;

function getClients() {
  clients ??= {
    agentcore: new BedrockAgentCoreClient({
      requestHandler: new NodeHttpHandler({ connectionTimeout: 5_000, requestTimeout: RUN_TIMEOUT_MS }),
      maxAttempts: 1, // run の再試行は inbox 側（attempts）で管理する
    }),
    sqs: new SQSClient({}),
    inbox: new DynamoInboxRepository(mustEnv('INBOX_TABLE')),
    messages: new DynamoMessageRepository(mustEnv('MESSAGES_TABLE')),
  };
  return clients;
}

export async function invokeAgentRuntime(
  client: BedrockAgentCoreClient,
  runtimeArn: string,
  req: RunRequest,
): Promise<RunResult> {
  const res = await client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: runtimeArn,
      // 記事の session ID をそのまま runtimeSessionId に使う（microVM が消えていても記録は S3 から復元される）
      runtimeSessionId: req.sessionId,
      contentType: 'application/json',
      accept: 'application/json',
      payload: new TextEncoder().encode(JSON.stringify(req)),
    }),
  );
  const text = (await res.response?.transformToString()) ?? '';
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`agent returned non-JSON response: ${text.slice(0, 200)}`);
  }
  const result = body as Partial<RunResult> & { error?: string };
  if (result.error || result.runId !== req.runId) {
    throw new Error(`agent error: ${result.error ?? 'runId mismatch'}`);
  }
  return result as RunResult;
}

export const handler = async (event: SQSEvent, context: Context): Promise<SQSBatchResponse> => {
  const c = getClients();
  const runtimeArn = mustEnv('AGENT_RUNTIME_ARN');
  const queueUrl = mustEnv('WAKE_QUEUE_URL');

  // 同じユーザー（= メッセージグループ）のレコードをまとめる
  const byUser = new Map<string, SQSRecord[]>();
  const failures: string[] = [];
  for (const record of event.Records) {
    let msg: WakeMessage | undefined;
    try {
      msg = JSON.parse(record.body) as WakeMessage;
    } catch {
      /* 壊れたメッセージは捨てる */
    }
    if (!msg || !isValidUserId(msg.userId)) {
      console.warn('drop invalid wake message', record.messageId);
      continue;
    }
    byUser.set(msg.userId, [...(byUser.get(msg.userId) ?? []), record]);
  }

  const deps: WorkerDeps = {
    inbox: c.inbox,
    messages: c.messages,
    invokeRun: (req) => invokeAgentRuntime(c.agentcore, runtimeArn, req),
    rewake: async (userId) => {
      await c.sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({ userId } satisfies WakeMessage),
          MessageGroupId: userId,
          MessageDeduplicationId: `rewake-${randomUUID()}`,
        }),
      );
    },
    newId: () => randomUUID(),
    newSessionId: () => `s-${randomUUID()}`,
    canStartRun: () => context.getRemainingTimeInMillis() > MIN_REMAINING_TO_START_MS,
    log: (msg, data) => {
      console.log(JSON.stringify({ msg, ...data }));
    },
  };

  for (const [userId, records] of byUser) {
    try {
      const result = await processUser(userId, deps, {
        owner: context.awsRequestId,
        leaseMs: LEASE_MS,
        maxRounds: 5,
        maxAttempts: 3,
        recentMessages: 5,
      });
      if (result.status === 'lease_busy') {
        // 前の worker が異常終了してリースが残っている。リース切れ後に SQS の再配信で再試行させる
        failures.push(...records.map((r) => r.messageId));
      }
    } catch (err) {
      console.error('worker error', { userId, err });
      failures.push(...records.map((r) => r.messageId));
    }
  }
  return { batchItemFailures: failures.map((itemIdentifier) => ({ itemIdentifier })) };
};

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
