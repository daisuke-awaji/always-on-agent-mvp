import type { FileStore } from './stores.js';

/**
 * ユーザーごとのメモリ（ファイルのディレクトリ）。
 * 記事の推奨レイアウト:
 *   instructions.md          ユーザーからの振る舞いの指示（毎回読み込む）
 *   notes/index.md, notes/*  ユーザーについて学んだこと（index だけ毎回読み込む）
 *   tasks/index.md, tasks/*  継続タスクの進捗（index だけ毎回読み込む）
 * 送信済みメッセージは worker が直近分を渡すので、ここでは持たない。
 */
export const AUTOLOAD_FILES = ['instructions.md', 'notes/index.md', 'tasks/index.md'] as const;

export const MEMORY_LIMITS = {
  maxFileBytes: 32 * 1024,
  maxFiles: 200,
  maxDepth: 4,
  maxPathLength: 200,
};

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export class MemoryError extends Error {}

/**
 * パスを正規化し、ユーザーのディレクトリの外に出られないようにする。
 * ""、"/"、"/memories"、"/memories/" はルートとみなす（Messages API の memory tool の慣習に合わせる）。
 */
export function normalizeMemoryPath(input: string): { path: string; isDir: boolean } {
  if (typeof input !== 'string') throw new MemoryError('path must be a string');
  let p = input.trim().replace(/\\/g, '/');
  if (p.startsWith('/memories')) p = p.slice('/memories'.length);
  p = p.replace(/^\/+/, '');
  const isDir = p === '' || p.endsWith('/');
  p = p.replace(/\/+$/, '');
  if (p.length > MEMORY_LIMITS.maxPathLength) throw new MemoryError('path too long');
  if (p === '') return { path: '', isDir: true };
  const segments = p.split('/');
  if (segments.length > MEMORY_LIMITS.maxDepth) throw new MemoryError(`path depth must be <= ${MEMORY_LIMITS.maxDepth}`);
  for (const s of segments) {
    if (s === '.' || s === '..' || !SEGMENT.test(s)) throw new MemoryError(`invalid path segment: ${s}`);
  }
  return { path: segments.join('/'), isDir };
}

export class MemoryStore {
  constructor(
    private readonly files: FileStore,
    private readonly userId: string,
  ) {}

  private prefix() {
    return `memory/${this.userId}/`;
  }

  private key(path: string) {
    return `${this.prefix()}${path}`;
  }

  async read(path: string): Promise<string | undefined> {
    return this.files.get(this.key(normalizeMemoryPath(path).path));
  }

  async listAll(): Promise<{ path: string; size: number }[]> {
    const items = await this.files.list(this.prefix());
    return items.map((i) => ({ path: i.key.slice(this.prefix().length), size: i.size }));
  }

  /** memory ツールの実行。戻り値はモデルに返すテキスト */
  async execute(input: MemoryToolInput): Promise<string> {
    const { path, isDir } = normalizeMemoryPath(input.path ?? '');
    switch (input.command) {
      case 'view': {
        if (!isDir) {
          const content = await this.files.get(this.key(path));
          if (content !== undefined) return content === '' ? '(空のファイル)' : content;
        }
        const dirPrefix = path === '' ? '' : `${path}/`;
        const entries = (await this.listAll()).filter((e) => e.path.startsWith(dirPrefix));
        if (entries.length === 0) {
          if (!isDir) throw new MemoryError(`file not found: ${path}`);
          return path === '' ? '(メモリは空です)' : `(ディレクトリ ${path}/ は空です)`;
        }
        return entries.map((e) => `${e.path}\t${e.size}B`).join('\n');
      }
      case 'create': {
        if (isDir || path === '') throw new MemoryError('create requires a file path');
        const text = requireString(input.file_text, 'file_text');
        this.checkSize(text);
        const existing = await this.files.get(this.key(path));
        if (existing === undefined && (await this.listAll()).length >= MEMORY_LIMITS.maxFiles) {
          throw new MemoryError(`too many files (max ${MEMORY_LIMITS.maxFiles}). 不要なファイルを削除するか統合してください`);
        }
        await this.files.put(this.key(path), text);
        return existing === undefined ? `created ${path}` : `overwrote ${path}`;
      }
      case 'str_replace': {
        const oldStr = requireString(input.old_str, 'old_str');
        const newStr = requireString(input.new_str ?? '', 'new_str');
        const content = await this.files.get(this.key(path));
        if (content === undefined) throw new MemoryError(`file not found: ${path}`);
        const count = oldStr === '' ? 0 : content.split(oldStr).length - 1;
        if (count !== 1) throw new MemoryError(`old_str must appear exactly once (found ${count})`);
        const updated = content.replace(oldStr, () => newStr);
        this.checkSize(updated);
        await this.files.put(this.key(path), updated);
        return `updated ${path}`;
      }
      case 'delete': {
        if (path === '') throw new MemoryError('cannot delete the memory root');
        const content = await this.files.get(this.key(path));
        if (content === undefined) throw new MemoryError(`file not found: ${path}`);
        await this.files.delete(this.key(path));
        return `deleted ${path}`;
      }
      default:
        throw new MemoryError(`unknown command: ${String((input as { command?: unknown }).command)}`);
    }
  }

  private checkSize(text: string) {
    if (Buffer.byteLength(text, 'utf8') > MEMORY_LIMITS.maxFileBytes) {
      throw new MemoryError(`file too large (max ${MEMORY_LIMITS.maxFileBytes} bytes). 内容を要約するか分割してください`);
    }
  }
}

export interface MemoryToolInput {
  command: 'view' | 'create' | 'str_replace' | 'delete';
  path: string;
  file_text?: string;
  old_str?: string;
  new_str?: string;
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new MemoryError(`${name} must be a string`);
  return v;
}
