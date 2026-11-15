import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import type { Message } from '@aws-sdk/client-bedrock-runtime';

/**
 * キーと値でファイルを読み書きする最小限の抽象。
 * 本番は S3、ローカル開発はファイルシステム。
 * 記事: "the directories should map to durable storage ... This way memories outlive the worker."
 */
export interface FileStore {
  get(key: string): Promise<string | undefined>;
  put(key: string, body: string, contentType?: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<{ key: string; size: number }[]>;
}

export class S3FileStore implements FileStore {
  constructor(
    private readonly bucket: string,
    private readonly s3: S3Client = new S3Client({}),
  ) {}

  async get(key: string): Promise<string | undefined> {
    try {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return await out.Body?.transformToString('utf-8');
    } catch (err) {
      if (err instanceof NoSuchKey || (err as { name?: string }).name === 'NoSuchKey') return undefined;
      throw err;
    }
  }

  async put(key: string, body: string, contentType = 'text/markdown; charset=utf-8'): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    const result: { key: string; size: number }[] = [];
    let token: string | undefined;
    do {
      const out: ListObjectsV2CommandOutput = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of out.Contents ?? []) if (o.Key) result.push({ key: o.Key, size: o.Size ?? 0 });
      token = out.NextContinuationToken;
    } while (token);
    return result;
  }
}

export class LocalFileStore implements FileStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    const p = join(this.root, ...key.split('/'));
    if (relative(this.root, p).startsWith('..')) throw new Error('path escapes root');
    return p;
  }

  async get(key: string): Promise<string | undefined> {
    try {
      return await readFile(this.path(key), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async put(key: string, body: string): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body, 'utf-8');
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    const out: { key: string; size: number }[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else {
          const key = relative(this.root, full).split(sep).join('/');
          if (key.startsWith(prefix)) out.push({ key, size: (await stat(full)).size });
        }
      }
    };
    await walk(this.root);
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }
}

// ---------------------------------------------------------------------------
// Session（記事: "a session, which is the transcript of messages and tool calls"）
// ---------------------------------------------------------------------------
export interface SessionRecord {
  sessionId: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  runs: number;
  messages: Message[];
}

export class SessionStore {
  constructor(private readonly files: FileStore) {}

  private key(userId: string, sessionId: string) {
    return `sessions/${userId}/${sessionId}.json`;
  }

  async load(userId: string, sessionId: string): Promise<SessionRecord | undefined> {
    const raw = await this.files.get(this.key(userId, sessionId));
    return raw ? (JSON.parse(raw) as SessionRecord) : undefined;
  }

  async save(record: SessionRecord): Promise<void> {
    await this.files.put(this.key(record.userId, record.sessionId), JSON.stringify(record), 'application/json');
  }
}
