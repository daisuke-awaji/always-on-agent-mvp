import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { SentMessageView } from './types.js';

/**
 * エージェントがユーザーに送ったメッセージ。
 * MVP では記事の「send ツールで直接届ける」形をとり、このテーブルを配信記録とする。
 * （正式な Outbox + Dispatcher は次の段階で、このテーブルの前段に追加する）
 *
 * pk = USER#<userId>, sk = MSG#<createdAt>#<messageId>
 */
export interface StoredMessage extends SentMessageView {
  messageId: string;
  userId: string;
  runId: string;
  importance: 'normal' | 'high';
}

export interface MessageRepository {
  put(msg: Omit<StoredMessage, 'messageId' | 'createdAt'>): Promise<StoredMessage>;
  listRecent(userId: string, limit: number): Promise<StoredMessage[]>;
}

const MESSAGE_TTL_SEC = 90 * 24 * 3600;

export class DynamoMessageRepository implements MessageRepository {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client: DynamoDBClient = new DynamoDBClient({}),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async put(msg: Omit<StoredMessage, 'messageId' | 'createdAt'>): Promise<StoredMessage> {
    const now = this.now();
    const stored: StoredMessage = { ...msg, messageId: randomUUID(), createdAt: now.toISOString() };
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `USER#${msg.userId}`,
          sk: `MSG#${stored.createdAt}#${stored.messageId}`,
          ...stored,
          ttl: Math.floor(now.getTime() / 1000) + MESSAGE_TTL_SEC,
        },
      }),
    );
    return stored;
  }

  async listRecent(userId: string, limit: number): Promise<StoredMessage[]> {
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :msg)',
        ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':msg': 'MSG#' },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (out.Items ?? []).map(({ pk: _pk, sk: _sk, ttl: _ttl, ...rest }) => rest as StoredMessage);
  }
}
