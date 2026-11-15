# Web UI mock

A frontend-only mock of the always-on agent's UI. There is no backend: [Mock Service Worker](https://mswjs.io/) answers the same API as `src/functions/handler.ts`, and a small simulator in the browser plays the worker and the agent.

Published at <https://daisuke-awaji.github.io/always-on-agent-mvp/> by [`.github/workflows/pages.yml`](../.github/workflows/pages.yml).

```bash
cd web
npm ci
npm run dev        # http://localhost:5173
npm run lint && npm run typecheck && npm test && npm run build
```

## The screen

One screen: chat. Each session is a thread, and a reply continues the same session. An earlier version compared three patterns (chat, inbox, console); chat was chosen, and the other two were removed. Old links such as `#/inbox/…` open the list of chats.

The API only returns events and sent messages. The UI rebuilds sessions from `runId` and `sessionId` (`src/ui/derive.ts`). An event that the agent decided not to report (a run with no message) belongs to no session, so it does not appear.

### Unread

The API has no read state, so the UI keeps the IDs of the read messages in `localStorage` (`src/ui/readState.ts`).

- Only the agent's messages count, not your own messages or incoming events.
- Each chat in the list shows its unread count, and its title is bold. The total is next to 会話 (at the top of the list, or in the top bar on phones) and in the browser tab title, for example `(3) 会話 — Always-on Agent`.
- A message becomes read only when its chat is on screen: not while a phone shows the list, and not while the browser tab is in the background.

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

## On phones

- Below 720 px the list and the chat are separate screens. The open chat is in the URL (`#/chat/<sessionId>`), so the device back gesture returns to the list and a link opens the same chat.
- The top bar shows 会話 and the unread count. Opening a chat hides it, so the thread and the reply box get the full height.
- Touch targets are at least 44 px. On touch devices inputs are 16 px, because iOS zooms into smaller ones. Safe-area insets keep content clear of the notch and the home bar, and `visualViewport` keeps the reply box above the iOS keyboard.
- Enter adds a new line (it also confirms Japanese input). Send with the button or ⌘/Ctrl + Enter.

Checked in headless Chromium with iPhone 13, Pixel 7, and landscape emulation, plus axe. axe still reports low contrast on two affectUI badges (重要 and 完了), which keep affectUI's default colors. The iOS keyboard and safe areas still need a check on a real device.

## UI components (affectUI)

The parts come from [affectUI](https://www.affectui.com/) (free items, MIT), in the clean style. Each one is a single `.tsx` file with its own styles, installed with the shadcn CLI into `src/components/ui/` and imported as `@/components/ui/<name>-clean`.

| Where | Item |
| --- | --- |
| Statuses, unread counts, 重要 | Badge |
| Buttons, the send button and its shortcut | Button, Icon Button, Tooltip |
| Sources and the agent | Avatar (the agent is `kind="agent"`) |
| Waiting for the agent | Thinking Loader, its label set from the event's real status (受付済み / 処理中) |
| Mock settings | Dialog (a bottom sheet on phones), Card |
| Loading and empty lists | Skeleton, Empty State, Spinner |

Rules:

- Don't edit the files in `src/components/ui/`. To update them, install again: `npx shadcn@latest add @affectui/<name>-clean --overwrite`. ESLint and Prettier skip that folder.
- Colors and shadows stay at affectUI's defaults. `src/styles.css` only sets `--aui-font` (a Japanese font stack) and `--aui-font-mono`, and uses the same grays for the hand-written parts. Color is only in status badges.
- `tsconfig.json` has no `noUncheckedIndexedAccess`: the affectUI files don't compile with it, and TypeScript can't turn it off per file. Our code still uses `.at()` and `Partial<Record<…>>` where a value can be missing.

## How the mock works

| File | Stands in for |
| --- | --- |
| `src/mocks/handlers.ts` | API Gateway + Handler λ (same paths, validation, and status codes) |
| `src/mocks/db.ts` | InboxTable and MessagesTable (kept in `localStorage`) |
| `src/mocks/simulator.ts` | SQS FIFO + Worker λ (one worker per user, batching, retries, `failed` after 3 attempts) |
| `src/mocks/brain.ts` | The agent on AgentCore Runtime (the fixed rules in the table above instead of Claude) |
| `src/mocks/scenarios.ts` | Seed data: normal, empty, and unhealthy (failures, slow reads, intermittent 500s) |

"モック設定" in the top bar switches the scenario and posts sample webhooks: something to bring tomorrow, a missed delivery, a bill due in 5 days, a usual card charge (no message), a suspicious notice, and the same webhook again (`duplicate: true`).

## Connecting to the real API

Set `VITE_API_BASE` to the API Gateway URL to turn the mock off. The real API uses IAM authentication, so a browser cannot call it as is: add user sign-in (for example Cognito) and derive `userId` from it first (see "Known limitations" in the root README).

## Hosting under a subpath

Pass `BASE_PATH` when building, for example `BASE_PATH=/always-on-agent-mvp/ npm run build`. The service worker is registered relative to it.
