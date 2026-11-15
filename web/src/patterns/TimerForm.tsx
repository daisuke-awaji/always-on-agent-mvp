import { useMemo, useState, type SyntheticEvent } from 'react';
import { Button } from '@/components/ui/button-clean';
import { DatePicker } from '@/components/ui/date-picker-clean';
import { SegmentedControl } from '@/components/ui/segmented-control-clean';
import { Select } from '@/components/ui/select-clean';
import { TextArea } from '@/components/ui/text-area-clean';
import { TextField } from '@/components/ui/text-field-clean';
import { TimePicker } from '@/components/ui/time-picker-clean';
import { ToggleGroup } from '@/components/ui/toggle-group-clean';
import { ApiError } from '../api/client';
import {
  TIMER_LIMITS,
  type CreateTimerBody,
  type Recurrence,
  type Timer,
  type TimerKind,
  type UpdateTimerBody,
} from '../api/schema';
import { dueLabel, nextOccurrence, parseHm, recurrenceLabel, untilLabel } from '../ui/timers';
import { useNow } from '../ui/useAgentData';

/**
 * タイマーを作る・変えるフォーム。作るときは種類（繰り返し / 1 回だけ）から選ぶ。変えるときは種類は変えられない。
 * 次に動く時刻をその場で見せる（保存する前に、思ったとおりかわかるように）。
 */
type Freq = Recurrence['freq'];

const FREQ_OPTIONS: { value: Freq; label: string }[] = [
  { value: 'daily', label: '毎日' },
  { value: 'weekly', label: '毎週' },
  { value: 'monthly', label: '毎月' },
];
const KIND_OPTIONS: { value: TimerKind; label: string }[] = [
  { value: 'schedule', label: '繰り返し' },
  { value: 'followup', label: '1 回だけ' },
];
// 月曜から並べる（値は Date.getDay() の 0〜6）
const WEEKDAY_ITEMS = ['1', '2', '3', '4', '5', '6', '0'].map((v) => ({
  value: v,
  label: '日月火水木金土'[Number(v)] ?? v,
}));
const DAY_OPTIONS = Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `${String(i + 1)}日` }));

const pad = (n: number) => String(n).padStart(2, '0');
const hmOf = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function TimerForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Timer;
  submitLabel: string;
  onSubmit: (body: CreateTimerBody | UpdateTimerBody) => Promise<void>;
  onCancel: () => void;
}) {
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const initDue = initial ? new Date(initial.dueAt) : new Date(today.getTime() + 86_400_000 + 9 * 3_600_000);

  const [kind, setKind] = useState<TimerKind>(initial?.kind ?? 'schedule');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [freq, setFreq] = useState<Freq>(initial?.recurrence?.freq ?? 'daily');
  const [time, setTime] = useState<string | null>(initial?.recurrence?.time ?? '07:00');
  const [weekdays, setWeekdays] = useState<string[]>(
    (initial?.recurrence?.weekdays ?? [new Date().getDay()]).map(String),
  );
  const [dayOfMonth, setDayOfMonth] = useState(String(initial?.recurrence?.dayOfMonth ?? 1));
  const [date, setDate] = useState<Date | null>(initDue);
  const [dtime, setDtime] = useState<string | null>(initial?.kind === 'followup' ? hmOf(initDue) : '09:00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [touched, setTouched] = useState(false);
  // 次に動く時刻の見積もりは、この時計で数える（30 秒ごとに進む）
  const now = useNow(30_000);

  // 入力から、繰り返し（schedule）か時刻（follow-up）を組み立てる。足りなければ理由を返す
  const plan = useMemo((): { recurrence?: Recurrence; dueAt?: Date; problem?: string } => {
    if (kind === 'schedule') {
      if (!time || !parseHm(time)) return { problem: '時刻を入れてください' };
      if (freq === 'weekly' && weekdays.length === 0) return { problem: '曜日を 1 つ以上選んでください' };
      const recurrence: Recurrence =
        freq === 'weekly'
          ? { freq, time, weekdays: weekdays.map(Number) }
          : freq === 'monthly'
            ? { freq, time, dayOfMonth: Number(dayOfMonth) }
            : { freq, time };
      return { recurrence, dueAt: nextOccurrence(recurrence, new Date(now)) };
    }
    const hm = dtime ? parseHm(dtime) : undefined;
    if (!date || !hm) return { problem: '日付と時刻を入れてください' };
    const dueAt = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hm.h, hm.m);
    if (dueAt.getTime() <= now) return { dueAt, problem: '過ぎた時刻は選べません' };
    return { dueAt };
  }, [kind, time, freq, weekdays, dayOfMonth, date, dtime, now]);

  const titleError = touched && title.trim() === '' ? 'エージェントがすることを書いてください' : undefined;

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    setTouched(true);
    if (title.trim() === '' || plan.problem || busy) return;
    setBusy(true);
    setError(undefined);
    const common = { title: title.trim(), note: note.trim() };
    const body: CreateTimerBody | UpdateTimerBody =
      kind === 'schedule'
        ? { ...(initial ? {} : { kind }), ...common, recurrence: plan.recurrence }
        : { ...(initial ? {} : { kind }), ...common, dueAt: plan.dueAt?.toISOString() };
    try {
      await onSubmit(body);
    } catch (err) {
      setError(err instanceof ApiError ? `保存できませんでした: ${err.message}` : '保存できませんでした');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={(e) => void submit(e)} noValidate>
      {!initial && (
        <div className="form-row">
          <span className="form-label" id="timer-kind-label">
            種類
          </span>
          <SegmentedControl
            options={KIND_OPTIONS}
            value={kind}
            onChange={setKind}
            variant="tray"
            aria-labelledby="timer-kind-label"
          />
        </div>
      )}
      <div className="form-field">
        <TextField
          label="エージェントがすること"
          aria-describedby="timer-title-hint"
          value={title}
          maxLength={TIMER_LIMITS.maxTitle}
          error={titleError}
          onChange={(e) => {
            setTitle(e.target.value);
          }}
        />
        <p className="form-hint" id="timer-title-hint">
          {kind === 'schedule' ? '例: 週末の予定のまとめ' : '例: 遠足の参加票の確認'}（{TIMER_LIMITS.maxTitle}{' '}
          文字まで）
        </p>
      </div>

      {kind === 'schedule' ? (
        <>
          <div className="form-row">
            <span className="form-label" id="timer-freq-label">
              繰り返し
            </span>
            <SegmentedControl
              options={FREQ_OPTIONS}
              value={freq}
              onChange={setFreq}
              variant="tray"
              aria-labelledby="timer-freq-label"
            />
          </div>
          {freq === 'weekly' && (
            <div className="form-row">
              <span className="form-label" id="timer-weekdays-label">
                曜日
              </span>
              <ToggleGroup
                type="multiple"
                items={WEEKDAY_ITEMS}
                value={weekdays}
                onChange={setWeekdays}
                aria-labelledby="timer-weekdays-label"
              />
            </div>
          )}
          <div className="form-grid">
            {freq === 'monthly' && (
              <Select label="日（1〜28 日）" options={DAY_OPTIONS} value={dayOfMonth} onChange={setDayOfMonth} />
            )}
            <TimePicker
              label="時刻"
              value={time}
              onChange={setTime}
              step={5}
              hourCycle={24}
              locale="ja-JP"
              placeholder="7:00"
            />
          </div>
        </>
      ) : (
        <div className="form-grid">
          <DatePicker
            label="日付"
            value={date}
            onChange={setDate}
            min={today}
            locale="ja-JP"
            weekStartsOn={0}
            placeholder="日付を選ぶ"
          />
          <TimePicker
            label="時刻"
            value={dtime}
            onChange={setDtime}
            step={5}
            hourCycle={24}
            locale="ja-JP"
            placeholder="9:00"
          />
        </div>
      )}

      <div className="form-field">
        <TextArea
          label="エージェントへのメモ（なくてもよい）"
          aria-describedby="timer-note-hint"
          value={note}
          maxLength={TIMER_LIMITS.maxNote}
          minRows={2}
          maxRows={6}
          onChange={(e) => {
            setNote(e.target.value);
          }}
        />
        <p className="form-hint" id="timer-note-hint">
          起きたときにエージェントが読みます。例: 金額と支払い方法も添える（{TIMER_LIMITS.maxNote} 文字まで）
        </p>
      </div>

      <p className={`form-preview ${plan.problem ? 'problem' : ''}`} role="status">
        {plan.problem
          ? plan.problem
          : plan.dueAt &&
            `${plan.recurrence ? `${recurrenceLabel(plan.recurrence)}。次は` : ''}${dueLabel(plan.dueAt.toISOString(), new Date(now))}（${untilLabel(plan.dueAt.toISOString(), now)}）に動きます`}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          やめる
        </Button>
        <Button type="submit" loading={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
