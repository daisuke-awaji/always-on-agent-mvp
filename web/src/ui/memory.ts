import { AUTOLOAD_FILES, MEMORY_LIMITS, type MemoryFileMeta } from '../api/schema';

/**
 * メモリのファイルの扱い。パスの規則は src/agent/memory.ts の normalizeMemoryPath と同じ
 * （..、絶対パス、使えない文字は受け付けない。深さは 4 まで）。
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function memoryPathError(path: string): string | undefined {
  if (path === '' || path.length > MEMORY_LIMITS.maxPathLength) return 'invalid path';
  const segments = path.split('/');
  if (segments.length > MEMORY_LIMITS.maxDepth) return `path depth must be <= ${String(MEMORY_LIMITS.maxDepth)}`;
  for (const s of segments) if (s === '.' || s === '..' || !SEGMENT.test(s)) return `invalid path segment: ${s}`;
  return undefined;
}

export const isAutoload = (path: string) => (AUTOLOAD_FILES as readonly string[]).includes(path);

export const byteLength = (s: string) => new TextEncoder().encode(s).byteLength;

/** index.md から、消したファイルを指している行を取り除く（"[...](family.md)" や "family.md" を含む行） */
export function removeIndexLinks(index: string, fileName: string): string {
  const lines = index.split('\n');
  const kept = lines.filter((l) => !(l.trimStart().startsWith('-') && l.includes(fileName)));
  return kept.join('\n');
}

/** 記事のメモリの種類。画面の見出しと説明に使う */
export interface MemoryGroup {
  id: 'instructions' | 'notes' | 'tasks' | 'other';
  label: string;
  description: string;
  files: MemoryFileMeta[];
}

export function groupMemory(files: MemoryFileMeta[]): MemoryGroup[] {
  const sortIndexFirst = (a: MemoryFileMeta, b: MemoryFileMeta) =>
    Number(b.path.endsWith('/index.md')) - Number(a.path.endsWith('/index.md')) || a.path.localeCompare(b.path);
  const pick = (f: (p: string) => boolean) => files.filter((x) => f(x.path)).sort(sortIndexFirst);
  const groups: MemoryGroup[] = [
    {
      id: 'instructions',
      label: 'あなたからの指示',
      description: '振る舞いについての指示。毎回の run の最初に読み込む。',
      files: pick((p) => p === 'instructions.md'),
    },
    {
      id: 'notes',
      label: 'あなたについてのメモ',
      description: 'エージェントが学んだこと。index.md だけ毎回読み込み、ほかは必要なときに開く。',
      files: pick((p) => p.startsWith('notes/')),
    },
    {
      id: 'tasks',
      label: '続いているタスク',
      description: 'タスクごとの進み具合（済んだこと、残り、次の一手）。index.md だけ毎回読み込む。',
      files: pick((p) => p.startsWith('tasks/')),
    },
    {
      id: 'other',
      label: 'そのほか',
      description: 'エージェントが必要なときに開く。',
      files: pick((p) => p !== 'instructions.md' && !p.startsWith('notes/') && !p.startsWith('tasks/')),
    },
  ];
  return groups.filter((g) => g.files.length > 0 || g.id !== 'other');
}

/** "4.2 KB" / "820 B" */
export function sizeLabel(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** ファイル名の部分（"notes/family.md" → "family.md"） */
export const baseName = (path: string) => path.split('/').at(-1) ?? path;
