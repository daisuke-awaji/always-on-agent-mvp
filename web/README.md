# Web UI mock

A frontend-only mock of the always-on agent's UI. There is no backend: [Mock Service Worker](https://mswjs.io/) answers the same API as `src/functions/handler.ts`, and a small simulator in the browser plays the worker and the agent.

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
