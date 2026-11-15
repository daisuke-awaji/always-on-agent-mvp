import { ConditionalCheckFailedException, DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { DynamoInboxRepository } from '../src/shared/inbox-repo.js';
import type { InboxEvent } from '../src/shared/types.js';

/**
 * DynamoDB への発行内容（条件式など）を検証する。
 * 意味論のテストは worker-core.test.ts（インメモリ実装）で行う。
 */
const ddb = mockClient(DynamoDBDocumentClient);
const fixedNow = new Date('2026-11-15T00:00:00.000Z');
// 万一モックが外れても実環境に届かないよう、到達不能なエンドポイントとダミーの認証情報を使う
const offlineClient = () =>
  new DynamoDBClient({
    region: 'ap-northeast-1',
    endpoint: 'http://127.0.0.1:9',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1,
  });
const repo = () => new DynamoInboxRepository('Inbox', offlineClient(), () => fixedNow);

beforeEach(() => ddb.reset());

describe('appendEvent', () => {
  it('sourceEventId があれば重複排除アイテムとイベントを 1 トランザクションで書く', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const { event, duplicate } = await repo().appendEvent({
      userId: 'u',
      type: 'webhook',
      source: 'github',
      sourceEventId: 'd-1',
      payload: { a: 1 },
    });
    expect(duplicate).toBe(false);
    expect(event.sk).toBe(`EVT#2026-11-15T00:00:00.000Z#${event.eventId}`);
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items).toHaveLength(2);
    expect(items[0]!.Put).toMatchObject({ Item: { pk: 'USER#u', sk: 'DEDUP#github#d-1' }, ConditionExpression: 'attribute_not_exists(pk)' });
    expect(items[1]!.Put).toMatchObject({ Item: { pk: 'USER#u', status: 'pending', attempts: 0 } });
  });

  it('重複排除アイテムの条件で失敗したら既存イベントを返す', async () => {
    ddb.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      }),
    );
    ddb
      .on(GetCommand, { Key: { pk: 'USER#u', sk: 'DEDUP#github#d-1' } })
      .resolves({ Item: { eventSk: 'EVT#old#e-0' } })
      .on(GetCommand, { Key: { pk: 'USER#u', sk: 'EVT#old#e-0' } })
      .resolves({ Item: { pk: 'USER#u', sk: 'EVT#old#e-0', eventId: 'e-0', status: 'done', ttl: 1 } });
    const r = await repo().appendEvent({ userId: 'u', type: 'webhook', source: 'github', sourceEventId: 'd-1', payload: {} });
    expect(r.duplicate).toBe(true);
    expect(r.event).toEqual({ sk: 'EVT#old#e-0', eventId: 'e-0', status: 'done' });
  });

  it('それ以外のエラーはそのまま投げる', async () => {
    ddb.on(TransactWriteCommand).rejects(new Error('throttled'));
    await expect(repo().appendEvent({ userId: 'u', type: 'webhook', source: 'x', sourceEventId: '1', payload: {} })).rejects.toThrow('throttled');
  });
});

describe('listOpenEvents', () => {
  it('強整合読み込みでページングしながら pending / processing を取得する', async () => {
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ pk: 'USER#u', sk: 'EVT#1', eventId: '1' }], LastEvaluatedKey: { pk: 'USER#u', sk: 'EVT#1' } })
      .resolvesOnce({ Items: [{ pk: 'USER#u', sk: 'EVT#2', eventId: '2' }] });
    const events = await repo().listOpenEvents('u');
    expect(events.map((e) => e.eventId)).toEqual(['1', '2']);
    const input = ddb.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ ConsistentRead: true, ScanIndexForward: true });
    expect(input.FilterExpression).toContain('IN (:pending, :processing)');
    expect(ddb.commandCalls(QueryCommand)[1]!.args[0].input.ExclusiveStartKey).toEqual({ pk: 'USER#u', sk: 'EVT#1' });
  });
});

describe('lease', () => {
  it('期限切れか自分が持ち主のときだけ取得できる条件で更新する', async () => {
    ddb.on(UpdateCommand).resolves({});
    expect(await repo().acquireLease('u', 'w1', 60_000)).toBe(true);
    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ConditionExpression).toBe('attribute_not_exists(pk) OR leaseUntil < :now OR #owner = :owner');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':owner': 'w1', ':now': fixedNow.getTime(), ':until': fixedNow.getTime() + 60_000 });
  });

  it('条件に合わなければ false', async () => {
    ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
    expect(await repo().acquireLease('u', 'w1', 60_000)).toBe(false);
  });

  it('解放は自分が持ち主のときだけ。他人に取られていても例外にしない', async () => {
    ddb.on(DeleteCommand).rejects(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
    await expect(repo().releaseLease('u', 'w1')).resolves.toBeUndefined();
    expect(ddb.commandCalls(DeleteCommand)[0]!.args[0].input.ConditionExpression).toBe('#owner = :owner');
  });
});

describe('status transitions', () => {
  const ev = (attempts: number) => ({ eventId: `e${attempts}`, sk: `EVT#x#e${attempts}`, attempts }) as InboxEvent;

  it('done は同じ runId のときだけ', async () => {
    ddb.on(UpdateCommand).resolves({});
    await repo().markDone('u', [ev(0)], 'run-1');
    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ConditionExpression).toBe('runId = :runId');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':done': 'done', ':runId': 'run-1' });
  });

  it('retry は上限に達したら failed、未満なら pending に戻す', async () => {
    ddb.on(UpdateCommand).resolves({});
    const { failed } = await repo().markRetry('u', [ev(0), ev(2)], 'boom', 3);
    expect(failed).toEqual(['e2']);
    const values = ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input.ExpressionAttributeValues!);
    expect(values.find((v) => v[':pending'])).toBeDefined();
    expect(values.find((v) => v[':failed'])).toBeDefined();
  });
});
