import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { MessageRepository } from '../shared/message-repo.js';

/**
 * send ツールの配信先。
 * 記事: "Most always-on agents can get by with a 'send' tool that delivers the message directly to the user."
 */
export interface OutgoingMessage {
  userId: string;
  sessionId: string;
  runId: string;
  text: string;
  importance: 'normal' | 'high';
}

export interface Sender {
  send(msg: OutgoingMessage): Promise<{ messageId: string }>;
}

/** DynamoDB に配信記録を残し、SNS トピックがあればメール等にも流す */
export class AwsSender implements Sender {
  constructor(
    private readonly messages: MessageRepository,
    private readonly topicArn?: string,
    private readonly sns: SNSClient = new SNSClient({}),
  ) {}

  async send(msg: OutgoingMessage): Promise<{ messageId: string }> {
    const stored = await this.messages.put(msg);
    if (this.topicArn) {
      await this.sns.send(
        new PublishCommand({
          TopicArn: this.topicArn,
          Subject: msg.importance === 'high' ? '[重要] エージェントからの連絡' : 'エージェントからの連絡',
          Message: `${msg.text}\n\n---\nuser: ${msg.userId}\nsession: ${msg.sessionId}\n（返信するには sessionId を指定して events に投稿してください）`,
          MessageAttributes: { userId: { DataType: 'String', StringValue: msg.userId } },
        }),
      );
    }
    return { messageId: stored.messageId };
  }
}

/** ローカル開発用: .local-state/messages/<userId>.jsonl に追記する */
export class LocalSender implements Sender {
  constructor(private readonly root: string) {}

  async send(msg: OutgoingMessage): Promise<{ messageId: string }> {
    const messageId = randomUUID();
    const dir = join(this.root, 'messages');
    await mkdir(dir, { recursive: true });
    const line = JSON.stringify({ messageId, createdAt: new Date().toISOString(), ...msg });
    await appendFile(join(dir, `${msg.userId}.jsonl`), `${line}\n`, 'utf-8');
    console.log(`[send_message] -> ${msg.userId}: ${msg.text}`);
    return { messageId };
  }
}
