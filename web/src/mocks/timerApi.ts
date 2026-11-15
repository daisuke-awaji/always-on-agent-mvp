import { http, HttpResponse } from 'msw';
import { recurrenceSchema, TIMER_LIMITS, timerKindSchema, type Recurrence, type Timer } from '../api/schema';
import { recurrenceError } from '../ui/timers';
import { getState, save } from './db';
import { bad, base, readBody, readGuard, writeGuard } from './http';
import { makeTimer, refreshTimer } from './records';

/**
 * タイマーの API（まだ実際の API にはない。ここで形を決める）。
 *   GET    /users/{userId}/timers            → 200 { timers }  動いているものは近い順、終わったものは新しい順に 20 件まで
 *   POST   /users/{userId}/timers            → 201 { timer }
 *   PATCH  /users/{userId}/timers/{timerId}  → 200 { timer }
 *   DELETE /users/{userId}/timers/{timerId}  → 200 { timer }（cancelled）
 */
const MAX_ENDED = 20;

export function listTimersOf(userId: string): Timer[] {
  const mine = getState().timers.filter((t) => t.userId === userId);
  const active = mine.filter((t) => t.status === 'active').sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const ended = mine
    .filter((t) => t.status !== 'active')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_ENDED);
  return [...active, ...ended];
}

type Fields = { title?: string; note?: string; dueAt?: string; recurrence?: Recurrence };

/** title / note / dueAt / recurrence の検証。partial なら省略してよい */
export function parseTimerFields(
  body: Record<string, unknown>,
  now: Date,
  partial: boolean,
): Fields | { error: string } {
  const out: Fields = {};
  if (body.title !== undefined || !partial) {
    if (typeof body.title !== 'string' || body.title.trim() === '') return { error: 'title is required' };
    if (body.title.trim().length > TIMER_LIMITS.maxTitle)
      return { error: `title must be <= ${String(TIMER_LIMITS.maxTitle)} characters` };
    out.title = body.title.trim();
  }
  if (body.note !== undefined) {
    if (typeof body.note !== 'string') return { error: 'note must be a string' };
    if (body.note.length > TIMER_LIMITS.maxNote)
      return { error: `note must be <= ${String(TIMER_LIMITS.maxNote)} characters` };
    out.note = body.note.trim();
  }
  if (body.dueAt !== undefined) {
    const t = typeof body.dueAt === 'string' ? Date.parse(body.dueAt) : NaN;
    if (Number.isNaN(t)) return { error: 'dueAt must be an ISO 8601 date-time' };
    if (t <= now.getTime()) return { error: 'dueAt must be in the future' };
    if (t > now.getTime() + TIMER_LIMITS.maxDaysAhead * 86_400_000)
      return { error: `dueAt must be within ${String(TIMER_LIMITS.maxDaysAhead)} days` };
    out.dueAt = new Date(t).toISOString();
  }
  if (body.recurrence !== undefined) {
    const r = recurrenceSchema.safeParse(body.recurrence);
    if (!r.success) return { error: 'invalid recurrence' };
    const err = recurrenceError(r.data);
    if (err) return { error: err };
    out.recurrence = r.data;
  }
  return out;
}

const findTimer = (userId: string, timerId: string) =>
  getState().timers.find((t) => t.userId === userId && t.timerId === timerId);

export const timerHandlers = [
  http.get(`${base}/timers`, async ({ params }) => {
    const userId = String(params.userId);
    const err = await readGuard(userId);
    if (err) return err;
    return HttpResponse.json({ timers: listTimersOf(userId) });
  }),

  http.post(`${base}/timers`, async ({ params, request }) => {
    const userId = String(params.userId);
    const err = await writeGuard(userId);
    if (err) return err;
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const kind = timerKindSchema.safeParse(body.kind);
    if (!kind.success) return bad(400, 'kind must be followup or schedule');
    const now = new Date();
    const f = parseTimerFields(body, now, false);
    if ('error' in f) return bad(400, f.error);
    if (kind.data === 'followup' && !f.dueAt) return bad(400, 'dueAt is required for followup');
    if (kind.data === 'schedule' && !f.recurrence) return bad(400, 'recurrence is required for schedule');
    const active = getState().timers.filter((t) => t.userId === userId && t.status === 'active').length;
    if (active >= TIMER_LIMITS.maxActive) return bad(409, `too many timers (max ${String(TIMER_LIMITS.maxActive)})`);

    const timer = makeTimer(
      {
        userId,
        kind: kind.data,
        title: f.title ?? '',
        note: f.note,
        dueAt: f.dueAt,
        recurrence: f.recurrence,
        createdBy: 'user',
      },
      now,
    );
    getState().timers.push(timer);
    save();
    return HttpResponse.json({ timer }, { status: 201 });
  }),

  http.patch(`${base}/timers/:timerId`, async ({ params, request }) => {
    const userId = String(params.userId);
    const err = await writeGuard(userId);
    if (err) return err;
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const timer = findTimer(userId, String(params.timerId));
    if (!timer) return bad(404, 'timer not found');
    if (timer.status !== 'active') return bad(409, `timer is ${timer.status}`);
    if (body.kind !== undefined && body.kind !== timer.kind) return bad(400, 'kind cannot be changed');
    const now = new Date();
    const f = parseTimerFields(body, now, true);
    if ('error' in f) return bad(400, f.error);
    if (timer.kind === 'followup' && f.recurrence) return bad(400, 'followup has no recurrence');
    if (timer.kind === 'schedule' && f.dueAt) return bad(400, 'schedule time comes from recurrence');

    if (f.title !== undefined) timer.title = f.title;
    if (f.note !== undefined) timer.note = f.note || undefined;
    if (f.dueAt) timer.dueAt = f.dueAt;
    if (f.recurrence) timer.recurrence = f.recurrence;
    refreshTimer(timer, now);
    save();
    return HttpResponse.json({ timer });
  }),

  http.delete(`${base}/timers/:timerId`, async ({ params }) => {
    const userId = String(params.userId);
    const err = await writeGuard(userId);
    if (err) return err;
    const timer = findTimer(userId, String(params.timerId));
    if (!timer) return bad(404, 'timer not found');
    if (timer.status !== 'active') return bad(409, `timer is ${timer.status}`);
    timer.status = 'cancelled';
    timer.updatedAt = new Date().toISOString();
    save();
    return HttpResponse.json({ timer });
  }),
];
