import { randomUUID } from 'node:crypto';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type { EventType, InboxEvent } from './types.js';

/**
 * Event inbox（記事の「durable list of events」）。
 *
 * テーブル: pk = USER#<userId>
 *   sk = EVT#<receivedAt>#<eventId>      イベント本体（status で状態管理）
 *   sk = DEDUP#<source>#<sourceEventId>  重複排除用（送信元 ID ごとに 1 件）
 *   sk = LOCK                            worker のリース（inbox ごとに worker は 1 つ）
 *
 * 記事のとおり「inbox が正」。SQS は worker を起こす信号にすぎず、
 * worker は起きたら必ずこのテーブルから pending を読み直す。
 */
export interface NewEventInput {
  userId: string;
  type: EventType;
  source: string;
  sourceEventId?: string;
  sessionId?: string;
  payload: unknown;
}

export interface InboxRepository {
  appendEvent(input: NewEventInput): Promise<{ event: InboxEvent; duplicate: boolean }>;
  /** pending と、前の worker が落ちて残った processing を古い順に返す（強整合読み込み） */
  listOpenEvents(userId: string): Promise<InboxEvent[]>;
  listRecentEvents(userId: string, limit: number): Promise<InboxEvent[]>;
  markProcessing(userId: string, events: InboxEvent[], runId: string): Promise<void>;
  markDone(userId: string, events: InboxEvent[], runId: string): Promise<void>;
  /** 失敗したイベントを pending に戻す。試行回数が上限に達したものは failed にする */
  markRetry(userId: string, events: InboxEvent[], error: string, maxAttempts: number): Promise<{ failed: string[] }>;
  acquireLease(userId: string, owner: string, leaseMs: number): Promise<boolean>;
  releaseLease(userId: string, owner: string): Promise<void>;
}

const DONE_TTL_SEC = 14 * 24 * 3600;
const DEDUP_TTL_SEC = 7 * 24 * 3600;

export const userPk = (userId: string) => `USER#${userId}`;
export const eventSk = (receivedAt: string, eventId: string) => `EVT#${receivedAt}#${eventId}`;

type Clock = () => Date;

export class DynamoInboxRepository implements InboxRepository {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client: DynamoDBClient = new DynamoDBClient({}),
    private readonly now: Clock = () => new Date(),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async appendEvent(input: NewEventInput): Promise<{ event: InboxEvent; duplicate: boolean }> {
    const nowIso = this.now().toISOString();
    const eventId = randomUUID();
    const sk = eventSk(nowIso, eventId);
    const event: InboxEvent = {
      eventId,
      userId: input.userId,
      type: input.type,
      source: input.source,
      sourceEventId: input.sourceEventId,
      sessionId: input.sessionId,
      payload: input.payload,
      status: 'pending',
      attempts: 0,
      receivedAt: nowIso,
      updatedAt: nowIso,
      sk,
    };
    const pk = userPk(input.userId);
    const eventItem = { pk, ...event };

    if (!input.sourceEventId) {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: this.tableName, Item: eventItem, ConditionExpression: 'attribute_not_exists(pk)' } },
          ],
        }),
      );
      return { event, duplicate: false };
    }

    const dedupSk = `DEDUP#${input.source}#${input.sourceEventId}`;
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: { pk, sk: dedupSk, eventSk: sk, ttl: this.epochSec() + DEDUP_TTL_SEC },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            { Put: { TableName: this.tableName, Item: eventItem, ConditionExpression: 'attribute_not_exists(pk)' } },
          ],
        }),
      );
      return { event, duplicate: false };
    } catch (err) {
      if (
        !(err instanceof TransactionCanceledException) ||
        err.CancellationReasons?.[0]?.Code !== 'ConditionalCheckFailed'
      ) {
        throw err;
      }
      // 同じ送信元 ID が既にある → 既存イベントを返す（Webhook の再送など）
      const dedup = await this.doc.send(
        new GetCommand({ TableName: this.tableName, Key: { pk, sk: dedupSk }, ConsistentRead: true }),
      );
      const existingSk = dedup.Item?.eventSk as string | undefined;
      if (existingSk) {
        const existing = await this.doc.send(
          new GetCommand({ TableName: this.tableName, Key: { pk, sk: existingSk }, ConsistentRead: true }),
        );
        if (existing.Item) return { event: toEvent(existing.Item), duplicate: true };
      }
      return { event, duplicate: true };
    }
  }

  async listOpenEvents(userId: string): Promise<InboxEvent[]> {
    const items = await this.queryAll({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :evt)',
      FilterExpression: '#status IN (:pending, :processing)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':pk': userPk(userId),
        ':evt': 'EVT#',
        ':pending': 'pending',
        ':processing': 'processing',
      },
      ConsistentRead: true,
      ScanIndexForward: true,
    });
    return items.map(toEvent);
  }

  async listRecentEvents(userId: string, limit: number): Promise<InboxEvent[]> {
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :evt)',
        ExpressionAttributeValues: { ':pk': userPk(userId), ':evt': 'EVT#' },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (out.Items ?? []).map(toEvent);
  }

  async markProcessing(userId: string, events: InboxEvent[], runId: string): Promise<void> {
    const nowIso = this.now().toISOString();
    await Promise.all(
      events.map((e) =>
        this.doc.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { pk: userPk(userId), sk: e.sk },
            UpdateExpression:
              'SET #status = :processing, attempts = if_not_exists(attempts, :zero) + :one, runId = :runId, updatedAt = :now',
            ConditionExpression: '#status IN (:pending, :processing)',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':processing': 'processing',
              ':pending': 'pending',
              ':zero': 0,
              ':one': 1,
              ':runId': runId,
              ':now': nowIso,
            },
          }),
        ),
      ),
    );
  }

  async markDone(userId: string, events: InboxEvent[], runId: string): Promise<void> {
    const nowIso = this.now().toISOString();
    await Promise.all(
      events.map((e) =>
        this.doc.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { pk: userPk(userId), sk: e.sk },
            UpdateExpression: 'SET #status = :done, updatedAt = :now, #ttl = :ttl REMOVE lastError',
            ConditionExpression: 'runId = :runId',
            ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
            ExpressionAttributeValues: {
              ':done': 'done',
              ':now': nowIso,
              ':ttl': this.epochSec() + DONE_TTL_SEC,
              ':runId': runId,
            },
          }),
        ),
      ),
    );
  }

  async markRetry(
    userId: string,
    events: InboxEvent[],
    error: string,
    maxAttempts: number,
  ): Promise<{ failed: string[] }> {
    const nowIso = this.now().toISOString();
    const failed: string[] = [];
    await Promise.all(
      events.map(async (e) => {
        // markProcessing で attempts は +1 済み。呼び出し側のオブジェクトは古い値なので +1 して判定する
        const attempts = e.attempts + 1;
        const giveUp = attempts >= maxAttempts;
        if (giveUp) failed.push(e.eventId);
        await this.doc.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { pk: userPk(userId), sk: e.sk },
            UpdateExpression: giveUp
              ? 'SET #status = :failed, updatedAt = :now, lastError = :err, #ttl = :ttl'
              : 'SET #status = :pending, updatedAt = :now, lastError = :err',
            ExpressionAttributeNames: giveUp ? { '#status': 'status', '#ttl': 'ttl' } : { '#status': 'status' },
            ExpressionAttributeValues: giveUp
              ? {
                  ':failed': 'failed',
                  ':now': nowIso,
                  ':err': error.slice(0, 1000),
                  ':ttl': this.epochSec() + DONE_TTL_SEC,
                }
              : { ':pending': 'pending', ':now': nowIso, ':err': error.slice(0, 1000) },
          }),
        );
      }),
    );
    return { failed };
  }

  async acquireLease(userId: string, owner: string, leaseMs: number): Promise<boolean> {
    const nowMs = this.now().getTime();
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: userPk(userId), sk: 'LOCK' },
          UpdateExpression: 'SET #owner = :owner, leaseUntil = :until, #ttl = :ttl',
          ConditionExpression: 'attribute_not_exists(pk) OR leaseUntil < :now OR #owner = :owner',
          ExpressionAttributeNames: { '#owner': 'owner', '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':owner': owner,
            ':until': nowMs + leaseMs,
            ':now': nowMs,
            ':ttl': Math.floor((nowMs + leaseMs) / 1000) + 3600,
          },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  async releaseLease(userId: string, owner: string): Promise<void> {
    try {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { pk: userPk(userId), sk: 'LOCK' },
          ConditionExpression: '#owner = :owner',
          ExpressionAttributeNames: { '#owner': 'owner' },
          ExpressionAttributeValues: { ':owner': owner },
        }),
      );
    } catch (err) {
      // リースが既に切れて他の worker が取得済みなら何もしない
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    }
  }

  private epochSec(): number {
    return Math.floor(this.now().getTime() / 1000);
  }

  private async queryAll(input: ConstructorParameters<typeof QueryCommand>[0]): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const out: QueryCommandOutput = await this.doc.send(new QueryCommand({ ...input, ExclusiveStartKey: startKey }));
      items.push(...((out.Items ?? []) as Record<string, unknown>[]));
      startKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
    return items;
  }
}

function toEvent(item: Record<string, unknown>): InboxEvent {
  const { pk: _pk, ttl: _ttl, ...rest } = item;
  return rest as unknown as InboxEvent;
}
