# Always-on Agent MVP on AWS

This sample builds an MVP on AWS following [Building always-on agents (Claude, 2026-11-13)](https://claude.com/ja/resources/articles/building-always-on-agents).

An always-on agent is not literally "always running". It sleeps most of the time, wakes when an event arrives, does a short **run**, saves its state, and goes back to sleep. This MVP implements three of the five components the article lists: the **Event inbox**, **Memory**, and the simple form of the **Outbox** (a send tool). The **Timers** and the rest of **Permissions** belong to later stages.

![Architecture: a client posts events through API Gateway to the Handler Lambda, which writes them to the Inbox table and sends a wake signal to an SQS FIFO queue. The Worker Lambda leases the user's inbox and invokes AgentCore Runtime, which calls Claude on Bedrock, keeps memory and sessions in S3, and sends messages to the Messages table and SNS.](docs/architecture.png)

**Try the UI mock:** <https://daisuke-awaji.github.io/always-on-agent-mvp/> runs in the browser with no backend (see [`web/README.md`](web/README.md)).

Thick arrows are the event flow, thin arrows are data reads and writes, and dashed arrows are failure handling and monitoring. The source is [`docs/architecture.drawio`](docs/architecture.drawio): edit it in [draw.io](https://www.drawio.com/), then export it to `docs/architecture.png` (PNG, zoom 200%, border 24, white background).

## How the article's components map to this sample

| Article | This sample | Implementation |
|---|---|---|
| Event inbox: durable list | `InboxTable` (DynamoDB) | `src/shared/inbox-repo.ts` |
| Event inbox: handler (ack fast) | API Gateway + `HandlerFn` | `src/functions/handler.ts` |
| Event inbox: worker | SQS FIFO + `WorkerFn` | `src/functions/worker.ts`, `worker-core.ts` |
| Run / agent loop | AgentCore Runtime (Converse API loop) | `src/agent/loop.ts`, `main.ts` |
| Session (transcript) | `s3://…/sessions/<userId>/<sessionId>.json` | `src/agent/stores.ts` |
| Memory (directory of files) | `s3://…/memory/<userId>/…` + `memory` tool | `src/agent/memory.ts` |
| Inside the context window | Static prompt → cachePoint → dynamic context | `src/agent/prompt.ts` |
| Outbox (send tool) | `send_message` → Messages table + SNS | `src/agent/sender.ts` |
| Timers / Permissions / formal Outbox | Not implemented (see roadmap) | — |

## Design highlights

### The inbox is the source of truth, with one worker per inbox

- SQS is **only a signal that wakes the worker**. Each time the worker wakes, it re-reads the pending events from DynamoDB with a strongly consistent read.
- Messages are sent with `MessageGroupId = userId`, so SQS FIFO processes **only one at a time per user**. A DynamoDB **lease** (a conditional update on `leaseUntil`) adds a second layer of exclusion.
- If a worker dies mid-run, the lease expires and the next worker picks up the remaining `processing` events. When `attempts` reaches 3, the event becomes `failed`.
- Pending events are **batched** into one run. Events that arrive during a run are picked up in the next round (the article's "push to next run" option).
- Each Lambda invocation uses at most 15 minutes. If there isn't enough time left to start a new run, the worker sends itself a new wake message, deferring the rest to the next invocation so no event is missed.

### Handler (ack fast)

- It only writes to the inbox and sends the wake signal, then returns `202`. Heavier checks such as prompt-injection detection happen inside the run, as the article recommends.
- When a `sourceEventId` is present, the dedupe item and the event are written in **one transaction**, so webhook retries don't create duplicate events.
- The wake signal is sent again even for duplicates. This avoids a missed event when the previous request died after writing to the inbox but before sending the wake signal. SQS merges these because the dedupe ID is the `eventId`.

### Sessions and AgentCore Runtime

- The article's session ID is used directly as the `runtimeSessionId`. The **transcript lives in S3**, so the microVM can stop after a short idle period (5 minutes) and a later run can still resume it. A Runtime session lasts at most 8 hours, but the article's sessions span days.
- Long transcripts are trimmed from the oldest messages, at a position that never splits a `toolUse`/`toolResult` pair. The prompt tells the agent to write anything worth keeping into memory as it goes.
- The agent is **deployed directly as code with Node 22**: esbuild bundles it into a single `main.js`, so no Docker is needed.

### Memory

The layout follows the article's recommendation. `instructions.md`, `notes/index.md`, and `tasks/index.md` are loaded automatically at the start of every run. Other files are read with the `memory` tool only when needed.

```
memory/<userId>/
  instructions.md      # Instructions from the user (loaded every run)
  notes/index.md       # Index of what was learned about the user (loaded every run)
  notes/*.md
  tasks/index.md       # List of ongoing tasks (loaded every run)
  tasks/<task-id>.md   # Progress (done, remaining, next step)
```

- Paths are normalized and validated. `..`, absolute paths, and invalid characters are rejected, and the agent cannot leave `memory/<userId>/`. Each file is limited to 32 KB and each user to 200 files.
- The bucket has **versioning** enabled, so memory can be restored if the agent corrupts it.
- To avoid repeating itself, the agent receives **the last 5 messages it sent**, which the worker reads and passes in (one of the two approaches the article describes).

### Outbox (send tool)

- `send_message` writes a record to the Messages table and, if configured, also delivers through SNS (for example, by email).
- Following the article's "start quiet and earn attention over time", the prompt tells the agent to be restrained, and a hard limit allows **at most 3 sends per run**.

### Context and cost

- The Converse API `system` is ordered as static prompt → `cachePoint` → dynamic context (time, memory, recently sent messages). A `cachePoint` is also placed at the end of the message history, so repeated tool calls within one run hit the cache.

## Repository layout

```
bin/app.ts                       CDK app
lib/always-on-agent-stack.ts     Stack (DynamoDB / SQS FIFO / API GW / Lambda / AgentCore Runtime / S3 / SNS)
src/shared/                      Contracts and repositories shared by handler / worker / agent
src/functions/handler.ts         Event inbox handler
src/functions/worker(-core).ts   Worker (lease, batching, retries, Runtime invocation)
src/agent/                       Code that runs on AgentCore Runtime
scripts/build-agent.mjs          esbuild bundling (runs automatically on cdk synth / deploy)
scripts/aoa.mjs                  Client for the deployed API (SigV4)
scripts/local-scenario.mjs       Check behavior locally against the real model
test/                            vitest (unit, integration, CDK assertions)
docs/architecture.drawio         Architecture diagram source (exported to docs/architecture.png)
web/                             Web UI mock (React + Mock Service Worker, no backend). See web/README.md
```

## Requirements

- Node.js 22 or later (Docker not required)
- An AWS account with Bedrock model access for the model in use (default: `jp.anthropic.claude-sonnet-4-6`, the Japan cross-region inference profile)
- A CDK-bootstrapped account and region (`npx cdk bootstrap`)

## Usage

```bash
npm ci
npm run lint             # ESLint (type-aware)
npm run format:check     # Prettier
npm run typecheck        # tsc (TypeScript 7)
npm test                 # Unit, integration, and CDK assertion tests (no AWS access)
npx cdk synth            # Bundles the agent, then synthesizes

# Deploy (optionally receive messages by email)
npx cdk deploy -c notifyEmail=you@example.com
```

### Trying it out

```bash
export AOA_API_URL=$(aws cloudformation describe-stacks --stack-name AlwaysOnAgentMvp \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)

# Message from the user (starts a new session)
node scripts/aoa.mjs send alice "Hi. I handle procurement. Only notify me about the dmp-procurement repo."

# Check the agent's reply (includes the sessionId)
node scripts/aoa.mjs messages alice

# Reply (resumes the same session)
node scripts/aoa.mjs send alice "Thanks. Please keep track of the checklist systemization progress." --session s-xxxxxxxx-....

# Webhook (duplicate deliveries are dropped by sourceEventId)
node scripts/aoa.mjs webhook alice github delivery-001 '{"repository":"dmp-procurement","action":"review_requested","pull_request":{"number":91}}'

# Event status (pending / processing / done / failed)
node scripts/aoa.mjs events alice
```

The bodies sent to `POST /users/{userId}/events` look like this.

```jsonc
// User message (shortcut)
{ "text": "...", "sessionId": "s-...(optional: resume a session)" }
// Generic event
{ "type": "webhook", "source": "github", "sourceEventId": "delivery-001", "payload": { } }
```

### Checking behavior locally (real model, no AWS resources)

Memory, sessions, and sent messages are stored in `.local-state/`. Only Bedrock is called.

```bash
npm run agent:local                 # http://localhost:8080 (ping / invocations)
node scripts/local-scenario.mjs     # In another terminal: 4 runs (instructions → ignorable notification → important notification + suspicious notification → session resume)
```

### CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs `npm ci` → `npm run lint` → `npm run format:check` → `npm run typecheck` → `npm test` → `cdk synth` on every push to `main` and on every pull request. The synthesized CloudFormation template is kept as an artifact (`cloudformation-template`, 7 days). It passes no AWS credentials, and both tests and synth complete without AWS access. Actions are pinned to commit SHAs, and the workflow token is limited to `contents: read`.

To run the same checks locally:

```bash
npm ci && npm run lint && npm run format:check && npm run typecheck && npm test && npx cdk synth --quiet
```

### GitHub Pages

[`.github/workflows/pages.yml`](.github/workflows/pages.yml) builds `web/` and publishes it to <https://daisuke-awaji.github.io/always-on-agent-mvp/> on each push to `main` that touches `web/`. The mock runs on Mock Service Worker, so it never reaches AWS. The repository's `github-pages` environment decides which branches may publish.

### Lint and format

- ESLint: `typescript-eslint` `strictTypeChecked` for all TypeScript, `@vitest/eslint-plugin` for `test/`, and `eslint-config-prettier` so ESLint does not check formatting. See [`eslint.config.mjs`](eslint.config.mjs) for the few rule options and the test-only relaxations.
- Prettier: `singleQuote`, `printWidth: 120`. Markdown is not formatted.
- `npm run lint:fix` and `npm run format` apply fixes. The formatting commit is listed in [`.git-blame-ignore-revs`](.git-blame-ignore-revs) (`git config blame.ignoreRevsFile .git-blame-ignore-revs`).

TypeScript 7 does not ship a compiler API yet, and `typescript-eslint` only supports TypeScript up to 6.0 ([typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)). The two are installed side by side, as the TypeScript team recommends:

| Package name | Resolves to | Used by |
| --- | --- | --- |
| `@typescript/native` | `typescript@7` | `tsc` (`npm run typecheck`) |
| `typescript` | `@typescript/typescript6` (6.0 API, `tsc6`) | ESLint (`require('typescript')`) |

When `typescript-eslint` supports TypeScript 7, replace both with a single `typescript@7`.

### Teardown

```bash
npx cdk destroy
```

`destroyOnRemoval` defaults to `true` (a setting for samples): the S3 bucket and tables are deleted along with the stack. For production, use `-c destroyOnRemoval=false`.

## Known limitations (MVP)

- **Duplicate sends**: if a run crashes after `send_message` but before the session is saved, the retry may send the same content again. This is resolved at the stage that adds the formal Outbox (idempotency key + dispatcher).
- **Client-side timeout**: if the Runtime call times out on the worker side, the run may still be executing in the Runtime. The run timeout (12 minutes) is set below the Lambda timeout (15 minutes).
- **Authorization**: the API only checks IAM authentication; any principal with permission can post events for any `userId`. In production, derive the `userId` from Cognito or similar claims.
- **Webhook signatures**: verification of external webhook signatures (such as GitHub's `X-Hub-Signature-256`) is not implemented. Add it to the handler.
- **Per-user isolation inside the Runtime**: the Runtime's IAM role can access every user's `memory/` and `sessions/`. The `userId` comes only from the worker (a trusted caller), and the code enforces the path boundary. For stronger isolation, use session-scoped credentials (ABAC).
- **No outbound network restrictions**: the Runtime uses `PUBLIC` network mode. Once external tools are added, place it in a VPC and route external access through AgentCore Gateway.

## Roadmap (article components still to add)

| Stage | Additions | AWS |
|---|---|---|
| Make the agent proactive (Timers) | `set_followup` / `create_schedule` tools, Timers table | EventBridge Scheduler (`at()` / `cron()`) → handler |
| Safety (Permissions) | Gateway-only access, credential injection, Cedar policies, risk classifier, deferred tool calls (approval flow) | AgentCore Gateway / Identity / Policy, Bedrock Guardrails |
| Mature operations (Outbox) | Outbox table + dispatcher (pacing, retries, digests), dreaming, evals for notification volume | DynamoDB Streams, AgentCore Memory / Evaluations / Observability |

## References

- [Building always-on agents](https://claude.com/ja/resources/articles/building-always-on-agents)
- [Direct code deployment for Node.js (AgentCore Runtime)](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-code-deploy-node.html)
- [Use isolated sessions for agents](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html)
- [Invoke an AgentCore Runtime agent](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-invoke-agent.html)
- [Amazon Bedrock AgentCore Construct Library (CDK)](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_bedrockagentcore-readme.html)
