import { delay, HttpResponse } from 'msw';
import { USER_ID_PATTERN } from '../api/schema';
import { getState } from './db';
import { SCENARIOS } from './scenarios';

/** モックの API の共通部品（パス、検証、シナリオの遅さと失敗） */
export const base = '*/mock-api/users/:userId';
export const scenario = () => SCENARIOS[getState().scenario];
export const bad = (status: number, error: string) => HttpResponse.json({ error }, { status });

const MAX_BODY_BYTES = 64 * 1024;

export function parseLimit(url: string): number {
  const n = Number(new URL(url).searchParams.get('limit') ?? 20);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 100) : 20;
}

/** 読み込み（GET）の前に: 遅さ、userId の検証、ときどき 500（調子が悪いシナリオ） */
export async function readGuard(userId: string): Promise<Response | undefined> {
  await delay(scenario().latencyMs);
  if (!USER_ID_PATTERN.test(userId)) return bad(400, 'invalid userId');
  if (Math.random() < scenario().readErrorRate) return bad(500, 'internal error');
  return undefined;
}

/** 書き込み（POST / PUT / PATCH / DELETE）の前に。書き込みは 500 にしない（画面の作り直しを確かめにくくなるので） */
export async function writeGuard(userId: string): Promise<Response | undefined> {
  await delay(Math.min(scenario().latencyMs, 400));
  if (!USER_ID_PATTERN.test(userId)) return bad(400, 'invalid userId');
  return undefined;
}

/** JSON オブジェクトの本文を読む。だめならエラーの応答を返す */
export async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  const raw = await request.text();
  if (!raw) return bad(400, 'body is required');
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return bad(413, 'body too large');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return bad(400, 'body must be JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad(400, 'body must be a JSON object');
  return body as Record<string, unknown>;
}
