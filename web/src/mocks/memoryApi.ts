import { http, HttpResponse } from 'msw';
import { MEMORY_LIMITS, type MemoryFileMeta } from '../api/schema';
import { baseName, byteLength, isAutoload, memoryPathError, removeIndexLinks } from '../ui/memory';
import { getState, save } from './db';
import { bad, base, readBody, readGuard, writeGuard } from './http';
import { fileOf, metaOf, versionOf, writeEntry } from './records';

/**
 * メモリの API（まだ実際の API にはない）。読み書きするのは、エージェントの memory ツールと同じファイル。
 *   GET    /users/{userId}/memory                 → 200 { files, limits }
 *   GET    /users/{userId}/memory/{path}          → 200 { file }
 *   PUT    /users/{userId}/memory/{path}          → 200 { file }   本文 { content, version }
 *   DELETE /users/{userId}/memory/{path}?version= → 204
 *
 * ・version が今の版と違えば 409（あいだにエージェントが書き換えた）。上書きも削除もしない
 * ・画面から作ることはしない（PUT は今あるファイルだけ。なければ 404）
 * ・毎回読み込むファイル（instructions.md、notes/index.md、tasks/index.md）は消せない（400）
 * ・notes/ と tasks/ のファイルを消したら、同じフォルダの index.md からそのファイルを指す行も消す
 */
export function listMemoryOf(userId: string): MemoryFileMeta[] {
  const files = getState().memory[userId] ?? {};
  return Object.entries(files)
    .flatMap(([path, e]) => (e ? [metaOf(path, e)] : []))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** URL の /memory/ より後ろをパスとして読む（"notes/family.md"） */
function pathOf(url: string): string {
  const p = new URL(url).pathname;
  const i = p.indexOf('/memory/');
  return i < 0
    ? ''
    : p
        .slice(i + '/memory/'.length)
        .split('/')
        .map(decodeURIComponent)
        .join('/');
}

export const memoryHandlers = [
  http.get(`${base}/memory`, async ({ params }) => {
    const userId = String(params.userId);
    const err = await readGuard(userId);
    if (err) return err;
    return HttpResponse.json({
      files: listMemoryOf(userId),
      limits: { maxFileBytes: MEMORY_LIMITS.maxFileBytes, maxFiles: MEMORY_LIMITS.maxFiles },
    });
  }),

  http.get(`${base}/memory/*`, async ({ params, request }) => {
    const userId = String(params.userId);
    const err = await readGuard(userId);
    if (err) return err;
    const path = pathOf(request.url);
    const pathErr = memoryPathError(path);
    if (pathErr) return bad(400, pathErr);
    const e = getState().memory[userId]?.[path];
    if (!e) return bad(404, 'file not found');
    return HttpResponse.json({ file: fileOf(path, e) });
  }),

  http.put(`${base}/memory/*`, async ({ params, request }) => {
    const userId = String(params.userId);
    const err = await writeGuard(userId);
    if (err) return err;
    const path = pathOf(request.url);
    const pathErr = memoryPathError(path);
    if (pathErr) return bad(400, pathErr);
    const body = await readBody(request);
    if (body instanceof Response) return body;
    if (typeof body.content !== 'string') return bad(400, 'content must be a string');
    if (typeof body.version !== 'string') return bad(400, 'version is required');
    if (byteLength(body.content) > MEMORY_LIMITS.maxFileBytes)
      return bad(413, `file too large (max ${String(MEMORY_LIMITS.maxFileBytes)} bytes)`);
    const e = getState().memory[userId]?.[path];
    if (!e) return bad(404, 'file not found');
    if (versionOf(e) !== body.version) return bad(409, 'version mismatch');

    const next = writeEntry(getState().memory, userId, path, body.content, 'user', new Date());
    save();
    return HttpResponse.json({ file: fileOf(path, next) });
  }),

  http.delete(`${base}/memory/*`, async ({ params, request }) => {
    const userId = String(params.userId);
    const err = await writeGuard(userId);
    if (err) return err;
    const path = pathOf(request.url);
    const pathErr = memoryPathError(path);
    if (pathErr) return bad(400, pathErr);
    if (isAutoload(path)) return bad(400, `${path} is loaded every run and cannot be deleted`);
    const files = getState().memory[userId];
    const e = files?.[path];
    if (!files || !e) return bad(404, 'file not found');
    const version = new URL(request.url).searchParams.get('version');
    if (!version) return bad(400, 'version is required');
    if (versionOf(e) !== version) return bad(409, 'version mismatch');

    Reflect.deleteProperty(files, path);
    // 同じフォルダの index.md から、このファイルを指す行を消す（index が消えたファイルを指したままにならないように）
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const indexPath = dir ? `${dir}/index.md` : '';
    const index = indexPath ? files[indexPath] : undefined;
    if (index) {
      const updated = removeIndexLinks(index.content, baseName(path));
      if (updated !== index.content) writeEntry(getState().memory, userId, indexPath, updated, 'user', new Date());
    }
    save();
    return new HttpResponse(null, { status: 204 });
  }),
];
