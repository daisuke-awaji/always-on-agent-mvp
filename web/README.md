# Web UI mock

A frontend-only mock of the always-on agent's UI. There is no backend: [Mock Service Worker](https://mswjs.io/) answers the same API as `src/functions/handler.ts`, and a small simulator in the browser plays the worker and the agent.

Published at <https://daisuke-awaji.github.io/always-on-agent-mvp/> by [`.github/workflows/pages.yml`](../.github/workflows/pages.yml).

```bash
cd web
npm ci
npm run dev        # http://localhost:5173
npm run lint && npm run typecheck && npm test && npm run build
```

## Three patterns

The same data, shown three ways (`#/chat`, `#/inbox`, `#/console`):

| | Pattern | Shows |
| --- | --- | --- |
| A | Chat | Each session as a thread. A reply continues the same session. |
| B | Inbox | The agent's messages as notifications, with the events that triggered each one, plus the events it chose not to report. |
| C | Console | Events and runs as they are (queued → running → sent / silent / failed, retries), and a form to post any event. |

The API only returns events and sent messages. The UI rebuilds sessions and runs from `runId` and `sessionId` (`src/ui/derive.ts`).

## On phones

- Below 720 px the list and the item are separate screens. The open item is in the URL (`#/chat/<sessionId>`, `#/inbox/<messageId>`), so the device back gesture returns to the list and a link opens the same item.
- The pattern switch moves to a bottom tab bar, with the unread count on 通知箱. Opening an item hides both bars, so the thread and the reply box get the full height.
- Touch targets are at least 44 px. On touch devices inputs are 16 px, because iOS zooms into smaller ones. Safe-area insets keep content clear of the notch and the home bar, and `visualViewport` keeps the reply box above the iOS keyboard.
- Enter adds a new line (it also confirms Japanese input). Send with the button or ⌘/Ctrl + Enter.
- In C, each run becomes a card and the send form is folded.

Checked in headless Chromium with iPhone 13, Pixel 7, and landscape emulation, plus axe. The iOS keyboard and safe areas still need a check on a real device.

## UI components (affectUI)

The parts come from [affectUI](https://www.affectui.com/) (free items, MIT), in the clean style. Each one is a single `.tsx` file with its own styles, installed with the shadcn CLI into `src/components/ui/` and imported as `@/components/ui/<name>-clean`.

| Where | Item |
| --- | --- |
| Statuses, counts, 重要 | Badge |
| Buttons, the send button and its shortcut | Button, Icon Button, Tooltip |
| Sources and the agent | Avatar (the agent is `kind="agent"`) |
| Waiting for the agent in A | Thinking Loader, its label set from the event's real status (受付済み / 処理中) |
| Filters | Segmented Control (B), Toggle Group (C, a Select on phones) |
| Mock settings | Dialog (a bottom sheet on phones), Card |
| C's send form | Select, Text Field, Text Area |
| C's run detail | Code Block (payload), Tool Call Card (`send_message`, with the same result string as `src/agent/loop.ts`) |
| Overview | Card |
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
| `src/mocks/brain.ts` | The agent on AgentCore Runtime (fixed rules instead of Claude) |
| `src/mocks/scenarios.ts` | Seed data: normal, empty, and unhealthy (failures, slow reads, intermittent 500s) |

"モック設定" in the top bar switches the scenario and posts sample webhooks.

## Connecting to the real API

Set `VITE_API_BASE` to the API Gateway URL to turn the mock off. The real API uses IAM authentication, so a browser cannot call it as is: add user sign-in (for example Cognito) and derive `userId` from it first (see "Known limitations" in the root README).

## Hosting under a subpath

Pass `BASE_PATH` when building, for example `BASE_PATH=/always-on-agent-mvp/ npm run build`. The service worker is registered relative to it.
