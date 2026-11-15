# Web UI mock

A frontend-only mock of the always-on agent's UI. There is no backend: [Mock Service Worker](https://mswjs.io/) answers the same API as `src/functions/handler.ts`, and a small simulator in the browser plays the worker and the agent.

Published at <https://daisuke-awaji.github.io/always-on-agent-mvp/> by [`.github/workflows/pages.yml`](../.github/workflows/pages.yml).

```bash
cd web
npm ci
npm run dev        # http://localhost:5173
npm run lint && npm run typecheck && npm test && npm run build
```

## The screens

Three screens: 会話 (chat), タイマー (timers), and メモリ (memory). On wide screens they are tabs in the top bar. On phones they are a tab bar at the bottom, hidden while something is open. Each screen is a list and a detail, and the open item is in the URL: `#/chat/<sessionId>`, `#/timers/<timerId>`, `#/memory/notes/family.md`.

In 会話, each session is a thread, and a reply continues the same session. An earlier version compared three patterns (chat, inbox, console); chat was chosen, and the other two were removed. Old links such as `#/inbox/…` open the list of chats.

The API only returns events and sent messages. The UI rebuilds sessions from `runId` and `sessionId` (`src/ui/derive.ts`). An event that the agent decided not to report (a run with no message) belongs to no session, so it does not appear.

### Unread

The API has no read state, so the UI keeps the IDs of the read messages in `localStorage` (`src/ui/readState.ts`).

- Only the agent's messages count, not your own messages or incoming events.
- Each chat in the list shows its unread count, and its title is bold. The total is next to 会話 (at the top of the list, or in the top bar on phones) and in the browser tab title, for example `(3) 会話 — Always-on Agent`.
- A message becomes read only when its chat is on screen: not while a phone shows the list, and not while the browser tab is in the background.

### Timers

The article's two kinds of timers, in separate sections:

- **繰り返し (schedule)**: wakes the agent on a fixed cadence, for example 朝のチェック every day at 7:00. Each time it starts a new session, and the agent stays quiet if there is nothing to report.
- **1 回だけ (follow-up)**: a deadline the agent sets for itself, for example "remind me the evening before the bill is due". It wakes the agent in the session that created it, and is done after it fires.

The detail shows the next time, the note for the agent, who created it (the agent or you), the session it belongs to, and the EventBridge Scheduler expression (`at(...)` / `cron(...)`, `Asia/Tokyo`). You can change the time and the note, cancel it (it stays in 終わったもの), and create new ones: daily, weekly on some days, monthly on a day from 1 to 28, or once at a date and time. The form shows the next time before you save.

### Memory

The files in the agent's `memory/<userId>/`, grouped like the article: あなたからの指示 (`instructions.md`), あなたについてのメモ (`notes/`), and 続いているタスク (`tasks/`). Files loaded at the start of every run are marked 毎回読み込む. Past messages are not files: the worker passes the last 5 to the agent.

- Open a file to read it, or edit it. The next run uses the new content.
- Delete old notes (the seed has one: `notes/swimming.md`, a swimming class that ended). Deleting a file also removes the lines in the folder's `index.md` that link to it. The three files loaded every run can be edited but not deleted.
- The agent can write a file while you edit it. Saving sends the version you started from, and the API answers 409 if the file changed. The screen notices the change before that, stops the save, and offers to load the latest version.

## The API for timers and memory

The real API has no timers or memory yet. The mock defines the shape (`src/api/schema.ts`, `src/mocks/timerApi.ts`, `src/mocks/memoryApi.ts`) so the backend can follow it.

| Method and path | Result | Errors |
| --- | --- | --- |
| `GET /users/{userId}/timers` | `200 { timers }`, active ones by next time, then up to 20 ended ones | |
| `POST /users/{userId}/timers` | `201 { timer }`, `createdBy: user` | 400 (validation), 409 (more than 30 active) |
| `PATCH /users/{userId}/timers/{timerId}` | `200 { timer }`: title, note, `dueAt` (follow-up) or `recurrence` (schedule) | 400, 404, 409 (not active) |
| `DELETE /users/{userId}/timers/{timerId}` | `200 { timer }` with `status: cancelled` | 404, 409 (not active) |
| `GET /users/{userId}/memory` | `200 { files, limits }` (path, size, `updatedAt`, `updatedBy`, `version`) | |
| `GET /users/{userId}/memory/{path}` | `200 { file }` with `content` | 400 (path), 404 |
| `PUT /users/{userId}/memory/{path}` | `200 { file }`, body `{ content, version }` | 400, 404 (no new files), 409 (version), 413 (over 32 KB) |
| `DELETE /users/{userId}/memory/{path}?version=` | `204` | 400 (loaded every run), 404, 409 (version) |

Timer validation: title up to 80 characters, note up to 500, a follow-up time in the future and within 366 days, `recurrence.time` as `HH:MM`, at least one weekday for weekly, a day of 1 to 28 for monthly. Memory paths follow `src/agent/memory.ts` (no `..`, depth up to 4). In the real stack, `version` would be the S3 ETag with a conditional write, and the timers would be a Timers table plus EventBridge Scheduler.

When a timer is due, the scheduler adds a `system` event with `source: scheduler` and `payload: { timerId, kind, title, note }` to the inbox, with `sourceEventId: timer:<timerId>:<dueAt>` so a retry is dropped as a duplicate. A follow-up becomes `done`; a schedule moves to its next time. If several times passed while nothing was running, it fires once.

## The use case

The mock shows an everyday use: a two-income family with a child in the third grade. The agent watches school notices, payment and renewal deadlines, and deliveries, and only speaks up when something needs attention. Everything else is kept as a record, with no message.

Each source posts a webhook with its own payload (`src/ui/payloads.ts`). The screen and the mock agent read them the same way.

| `source` | Example | High (重要) | Normal | No message |
| --- | --- | --- | --- | --- |
| `school` | A school notice with a due date and things to bring | Due today or tomorrow | Due within 3 days | No due date, or later |
| `calendar` | A family calendar event added or changed | — | Starts within 36 hours | Later |
| `card` | A card charge with the usual amount | 1.5 times the usual or more | — | Usual amount, or no usual amount |
| `bills` | A bill or a subscription renewal | Due within 2 days | Due within 7 days | Later |
| `delivery` | Shipped, out for delivery, missed, delivered | Missed delivery | Arriving today | Shipped or delivered |
| `shop` | An order, or the deadline to change a regular order | — | Change deadline within 2 days | Order received |

Days are counted from when the notice arrived. A notice that contains instructions for the agent (for example, asking for a card number) is held, and the agent only reports that it held it. The seed history is two days of these notices, placed at times they would really arrive (school in the afternoon, deliveries in the morning).

The mock agent also writes memory and timers:

- 「〜だけ知らせて」 adds a line to `instructions.md`, and 「覚えて」 writes a note in `notes/`.
- 「思い出させて」 creates a follow-up and a file in `tasks/`. It reads simple phrases for the time: N分後, N時間後, 明日, あさって, N日後, 来週, M月D日, and "M月 … 1か月前", with N時 for the hour (9:00 otherwise, 3 days later if nothing matches).
- A bill or renewal due in 3 to 7 days gets a follow-up at 19:00 the day before.
- When a follow-up fires, it sends 「リマインドです」 in the same session. 朝のチェック stays quiet. Other schedules send a short message (the mock does not write a real summary).

The real agent reads its memory on every run. The mock agent does not read memory, so editing `instructions.md` does not change what it reports.

## On phones

- Below 720 px the list and the chat are separate screens. The open chat is in the URL (`#/chat/<sessionId>`), so the device back gesture returns to the list and a link opens the same chat.
- The top bar shows the screen name (and the unread count on 会話). The tab bar at the bottom switches between 会話, タイマー, and メモリ, with the unread count and the number of active timers. Opening a chat, a timer, or a file hides both bars, so it gets the full height.
- Touch targets are at least 44 px. On touch devices inputs are 16 px, because iOS zooms into smaller ones. Safe-area insets keep content clear of the notch and the home bar, and `visualViewport` keeps the reply box above the iOS keyboard.
- Enter adds a new line (it also confirms Japanese input). Send with the button or ⌘/Ctrl + Enter.

Checked in headless Chromium with iPhone 13, Pixel 7, and landscape emulation, plus axe. axe still reports low contrast on two affectUI badges (重要 and 完了), which keep affectUI's default colors. The iOS keyboard and safe areas still need a check on a real device.

The timer and memory screens pass axe on wide screens and on iPhone 13. To get there without editing affectUI: timer statuses are gray badges (動いている has a dot), and field hints are our own text instead of the Text Field and Text Area `hint` and `counter` (their gray is too light). The Date Picker's month buttons are named in English (Previous month / Next month) by affectUI.

## UI components (affectUI)

The parts come from [affectUI](https://www.affectui.com/) (free items, MIT), in the clean style. Each one is a single `.tsx` file with its own styles, installed with the shadcn CLI into `src/components/ui/` and imported as `@/components/ui/<name>-clean`.

| Where | Item |
| --- | --- |
| Statuses, unread counts, 重要 | Badge |
| Buttons, the send button and its shortcut | Button, Icon Button, Tooltip |
| Sources and the agent | Avatar (the agent is `kind="agent"`) |
| Waiting for the agent | Thinking Loader, its label set from the event's real status (受付済み / 処理中) |
| Mock settings | Dialog (a bottom sheet on phones), Card |
| Timer form | Text Field, Text Area, Segmented Control (kind, daily/weekly/monthly), Toggle Group (weekdays), Select (day of month), Date Picker, Time Picker |
| Cancel a timer, delete a file | Alert Dialog (in the Dialog file) |
| Memory editor | Text Area |
| Loading and empty lists | Skeleton, Empty State, Spinner |

Rules:

- Don't edit the files in `src/components/ui/`. To update them, install again: `npx shadcn@latest add @affectui/<name>-clean --overwrite`. ESLint and Prettier skip that folder.
- Colors and shadows stay at affectUI's defaults. `src/styles.css` only sets `--aui-font` (a Japanese font stack) and `--aui-font-mono`, and uses the same grays for the hand-written parts. Color is only in status badges.
- `tsconfig.json` has no `noUncheckedIndexedAccess`: the affectUI files don't compile with it, and TypeScript can't turn it off per file. Our code still uses `.at()` and `Partial<Record<…>>` where a value can be missing.

## How the mock works

| File | Stands in for |
| --- | --- |
| `src/mocks/handlers.ts` | API Gateway + Handler λ (same paths, validation, and status codes) |
| `src/mocks/timerApi.ts`, `memoryApi.ts` | The timer and memory API above (not in the real stack yet) |
| `src/mocks/db.ts` | InboxTable, MessagesTable, a Timers table, and S3 `memory/` (kept in `localStorage`) |
| `src/mocks/simulator.ts` | SQS FIFO + Worker λ (one worker per user, batching, retries, `failed` after 3 attempts), and EventBridge Scheduler (checks due timers every 3 seconds) |
| `src/mocks/brain.ts` | The agent on AgentCore Runtime (the fixed rules in the table above instead of Claude) |
| `src/mocks/scenarios.ts` | Seed data: normal, empty, and unhealthy (failures, slow reads, intermittent 500s) |

"モック設定" in the top bar switches the scenario and posts sample webhooks: something to bring tomorrow, a missed delivery, a bill due in 5 days, a usual card charge (no message), a suspicious notice, and the same webhook again (`duplicate: true`). It can also fire an active timer now (a schedule keeps its next time), and make the agent add a line to `instructions.md`, to see what happens when you are editing that file.

## Connecting to the real API

Set `VITE_API_BASE` to the API Gateway URL to turn the mock off. The real API uses IAM authentication, so a browser cannot call it as is: add user sign-in (for example Cognito) and derive `userId` from it first (see "Known limitations" in the root README).

## Hosting under a subpath

Pass `BASE_PATH` when building, for example `BASE_PATH=/always-on-agent-mvp/ npm run build`. The service worker is registered relative to it.
