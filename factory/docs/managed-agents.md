# Agents on DigitalOcean Managed Agents

`src/factory/managed.ts` runs a factory agent on DigitalOcean Managed Agents (the **Harness Runtime** part)
instead of on this machine. It has the same contract as `runAgent` in `agents.ts`; the factory selects it with
`AGENT_RUNTIME=do-managed`:

```ts
// src/factory/index.ts, default deps of runFactory
runAgent: process.env.AGENT_RUNTIME === 'do-managed' ? runAgentManaged : runAgent,
```

`runAgentManaged<T>(options, deps?)` is assignable to `typeof runAgent`. It needs `DO_API_TOKEN` (a DigitalOcean
API token) next to the usual `DO_MODEL_ACCESS_KEY`.

**Status (2026-11-13, 12:30 PST): works end to end, live.** `tests/managed.test.ts` has a live proof (skipped
in `pnpm check`): a scratch repo with a failing `node --test` test and a one-line bug; Claude Code on Managed
Agents with `kimi-k3.1-pro` runs the test, fixes the bug, reruns the test, and the patch lands locally where the
test then passes. Run it from `factory/`:

```bash
MANAGED_LIVE=1 node --env-file-if-exists=.env --test --test-name-pattern=live tests/managed.test.ts
```

Measured on that case (four runs): **19–32 s per run** end to end (sandbox create to ready about 10 s, upload,
the agent's turn, patch, teardown), **$0.11–0.19 per run** as reported by the platform (`run_cost_micros`;
about 20k input tokens, 50–100k cache reads, 1–2k output tokens). Every session and its saved Environment Config
were removed afterwards. `MANAGED_DEBUG=1` prints every platform event to stderr.

## What the platform gives us

Read from https://docs.digitalocean.com/products/managed-agents/ and the Harness Runtime API reference
(https://docs.digitalocean.com/reference/api/reference/harness-runtime/), public preview.

- **Harnesses:** `claude-code`, `codex`, `opencode`, `hermes`, `langgraph`, `crewai`, `openhands`, `custom`
  (your own image), `none` (a bare sandbox driven by exec/upload/download). We use `claude-code`.
- **Sandbox:** Firecracker microVM, Ubuntu 24.04, cwd `/workspace`, with Git, Python 3, `gh`, curl,
  build-essential. The docs say Node.js 20 for the base image; the `claude-code` image has **Node v24.22.1**
  (seen live). Sizes `mars-1vcpu-1gb` … `mars-16vcpu-32gb` (we use the default `mars-2vcpu-4gb`).
- **Model:** env `HARNESS_INFERENCE_MODEL` (a Serverless Inference model ID such as `kimi-k3.1-pro`) plus
  secret `HARNESS_INFERENCE_API_KEY` (a model access key). Claude Code then talks to DigitalOcean's inference
  endpoint, and the endpoint is added to the egress allowlist automatically. Works with Jarda's key and the
  open-weight models; no 403.
- **Auth:** `Authorization: Bearer <DigitalOcean API token>` on `https://api.digitalocean.com`, scopes
  `agent_harness_session:{create,read,update,delete}`.
- **API used** (all under `/v2/agents`):

  | Step | Call |
  |---|---|
  | Create the sandbox | `POST /sessions` with the environment spec as `application/yaml` (JSON is valid YAML). Returns `session.session_id` and `session.config_id` (creating saves an Environment Config) |
  | Wait for boot | `GET /sessions/{id}` until `status` is `SESSION_STATUS_READY` (it passes through `SESSION_STATUS_PROVISIONING`) |
  | Files in | `POST /sessions/{id}/workspace/upload?path=…` (raw bytes or tar, ≤ 500 MiB, optional `X-Content-Sha256`) |
  | Run a command | `POST /sessions/{id}/sandbox/exec` `{argv, workdir, timeout_seconds ≤ 240}` → `{exit_code, stdout, stderr}` as plain strings, no shell, 1 MiB output cap. Runs as `root`; `/workspace` belongs to the agent's user `agent` |
  | Prompt the agent | `POST /sessions/{id}/input` `{text}` → `{run_id}` |
  | Progress | `GET /sessions/{id}/events`: SSE; `run.token_delta`, `run.tool_call_started/completed`, `run.cost_accrued`, `run.completed {run_cost_micros, total_tokens_in/out, total_cache_read_input_tokens}`, `run.failed`, `run.human_input_requested`, plus `run.log` and `stream.state`. At-least-once delivery, dedupe by `event_id` |
  | Stop a turn | `POST /sessions/{id}/cancel` |
  | Files out | `GET /sessions/{id}/workspace/download?path=…`: payload plus a 73-byte `DOWSSHA1<sha256>\n` footer to strip and verify |
  | Clean up | `DELETE /sessions/{id}`, then `DELETE /configs/{config_id}` |

- **Price:** CPU $0.044 per vCPU-hour of CPU actually used, memory $0.0095 per GB-hour allocated, billed per
  second, so a 30-second sandbox is a fraction of a cent; the run cost is almost all inference. Needs a funded
  balance (promotional credit, Inference and Agents balance, or account prepayment).

## How `runAgentManaged` works

1. Tars the worktree as the agent would see it locally: tracked and untracked files, no ignored files (so no
   `node_modules`, no `.env`), no `.git`.
2. Creates a `claude-code` session: the model and model key from the options (the key as a write-only secret),
   `ANTHROPIC_DEFAULT_HAIKU_MODEL` set to the small model, egress limited to `inference.do-ai.run`, and the
   tool policy as permissions (below).
3. Uploads the tar, extracts it in `/workspace`, commits it there as a git baseline (with `safe.directory`,
   since exec runs as root and the workspace belongs to `agent`), and hands the files to the workspace owner.
   The harness's own files (`.agent-home/`, `claude-code.log`) are excluded from git.
4. Sends the system prompt and prompt as one input (the harness has no system-prompt field), plus "end with a
   ```json block matching this schema" when the options carry a schema. Streams the events: tool calls go to
   `onStep`, the text after the last tool call is the answer, `run.completed` gives the cost.
5. `git add -A` in the sandbox, keeps only changed paths under `policy.writable`, downloads that patch, refuses
   symlinks, and `git apply`s it to the local worktree. Changes elsewhere are dropped and reported via `onStep`.
   This also happens when the run failed, like a local run that leaves its edits behind.
6. Parses the JSON answer (last ```json block, checking the schema's `required` keys) and removes the session
   and its saved config, also on failure.

The factory's own checks, limits and tests then run locally on the patched worktree, unchanged.

### The policy: what holds and what doesn't (probed live)

| Local guard (`createToolGuard`) | On Managed Agents |
|---|---|
| Writes only under `writable` | **Holds.** Edit/Write outside `writable` is denied in the sandbox ("Permission to use Edit has been denied"), and the patch filter drops anything else (a Bash `sed`, for example), so nothing outside `writable` reaches the worktree |
| Bash only for `commands`, no chaining | **Doesn't hold.** With the per-command allow rules, any command runs (`ls -la` ran with only `node --test` allowed). A catch-all bash deny removes the shell completely, allowed commands included, so the agent couldn't run its tests. We keep the shell for agents that have `Bash`; it runs in the throwaway microVM with egress limited to the inference host, and its file changes still go through the patch filter. Agents without `Bash` get the deny |
| Reads stay inside the repository | Reads anywhere in the sandbox, which holds only the repository copy |
| No other tools | `default: deny` doesn't cover Claude Code's `Agent`, `SendMessage` and `ListAgents` (the model used them once when it had no shell); they act only inside the sandbox |
| `maxTurns` | No turn limit in the API: the run is cancelled after `maxTurns` tool calls |
| `maxBudgetUsd` | Cancelled when `run.cost_accrued` passes it |
| `outputFormat` JSON schema | No structured output: the answer is asked for as a ```json block and parsed (worked every live run) |

The model key is in the agent's environment in the sandbox, as it is locally; the egress allowlist keeps it
from going anywhere but the inference endpoint.

## Gaps

- **Scraper tests in the sandbox:** Node 24 is there, but `node_modules` aren't uploaded and there's no npm
  egress, so `pnpm check` in a scraper probably fails inside the sandbox (not tried). The factory still runs it
  locally after the patch lands. Fix: allow `registry.npmjs.org` and run `pnpm install --frozen-lockfile` after
  seeding, or a custom template with the dependencies.
- **Answer text:** `run.token_delta` with `kimi-k3.1-pro` includes some of the model's reasoning before the
  final answer, so `text` is noisier than locally. The JSON block parses fine.
- **Small model:** `ANTHROPIC_DEFAULT_HAIKU_MODEL` is passed; no 403 showed up in the live runs, but nothing
  proved the harness used it.
- **Concurrency and speed:** each run pays about 10 s of sandbox boot and a few seconds of upload/teardown; up
  to 100 concurrent sessions per team.
