# Agents on DigitalOcean Managed Agents

`src/factory/managed.ts` runs a factory agent on DigitalOcean Managed Agents (the **Harness Runtime** part)
instead of on this machine. It has the same contract as `runAgent` in `agents.ts`; the factory selects it with
`AGENT_RUNTIME=do-managed` (wire `deps.runAgent` to `runAgentManaged` in `index.ts`).

Status (2026-11-13, 12:10 PST): built and tested offline against a fake API. **Not run live yet**: it needs a
DigitalOcean API token, which the project doesn't have yet (see "What it needs").

## What the platform gives us

Read from https://docs.digitalocean.com/products/managed-agents/ and the Harness Runtime API reference
(https://docs.digitalocean.com/reference/api/reference/harness-runtime/), public preview.

- **Harnesses:** `claude-code`, `codex`, `opencode`, `hermes`, `langgraph`, `crewai`, `openhands`, `custom`
  (your own image), `none` (a bare sandbox driven by exec/upload/download). We use `claude-code`.
- **Sandbox:** Firecracker microVM, Ubuntu 24.04, root, cwd `/workspace`, with Git, Python 3, **Node.js 20**,
  `gh`, curl, build-essential. Sizes `mars-1vcpu-1gb` … `mars-16vcpu-32gb` (default `mars-2vcpu-4gb`).
- **Model:** env `HARNESS_INFERENCE_MODEL` (a Serverless Inference model ID such as `kimi-k3.1-pro`) plus
  secret `HARNESS_INFERENCE_API_KEY` (a model access key). Claude Code then talks to DigitalOcean's inference
  endpoint, and the endpoint is added to the egress allowlist automatically. `ANTHROPIC_API_KEY` instead bills
  Anthropic directly.
- **Auth:** `Authorization: Bearer <DigitalOcean API token>` on `https://api.digitalocean.com`. Scopes follow
  the `agent_harness_session:{create,read,update,delete}` pattern (the reference names
  `agent_harness_session:create` explicitly).
- **API used** (all under `/v2/agents`):

  | Step | Call |
  |---|---|
  | Create the sandbox | `POST /sessions` with the environment spec as `application/yaml` (JSON is valid YAML). Returns `session.session_id` and `session.config_id` (creating saves an Environment Config) |
  | Wait for boot | `GET /sessions/{id}` until `status` is `SESSION_STATUS_READY` |
  | Files in | `POST /sessions/{id}/workspace/upload?path=…` (raw bytes or tar, ≤ 500 MiB, optional `X-Content-Sha256`) |
  | Run a command | `POST /sessions/{id}/sandbox/exec` `{argv, workdir, timeout_seconds ≤ 240}` → `{exit_code, stdout, stderr}`, no shell, 1 MiB output cap |
  | Prompt the agent | `POST /sessions/{id}/input` `{text}` → `{run_id}` |
  | Progress | `GET /sessions/{id}/events`: SSE; `run.token_delta`, `run.tool_call_started`, `run.cost_accrued`, `run.completed {run_cost_micros, total_tokens_in/out}`, `run.failed`, `run.human_input_requested`. At-least-once delivery, dedupe by `event_id` |
  | Stop a turn | `POST /sessions/{id}/cancel` |
  | Files out | `GET /sessions/{id}/workspace/download?path=…`: payload plus a 73-byte `DOWSSHA1<sha256>\n` footer to strip and verify |
  | Clean up | `DELETE /sessions/{id}`, then `DELETE /configs/{config_id}` |

- **Policy:** a `permissions` block (`default` allow/ask/deny, rules on `bash`, `file.read`, `file.write` with
  literal `match` globs on `command` or `path`, last match wins) and `filesystem.mode: workspace-write`, which
  the sandbox enforces. `egress` is an outbound host allowlist.
- **Price:** CPU $0.044 per vCPU-hour of CPU actually used, memory $0.0095 per GB-hour allocated, billed per
  second; a session pauses after its idle timeout. Inference is billed as normal Serverless Inference. Needs a
  funded balance (promotional credit, Inference and Agents balance, or account prepayment).

## How `runAgentManaged` works

1. Tars the worktree as the agent would see it locally: tracked and untracked files, no ignored files (so no
   `node_modules`, no `.env`), no `.git`.
2. Creates a `claude-code` session: the model and model key from the options (the key as a write-only secret),
   `ANTHROPIC_DEFAULT_HAIKU_MODEL` set to the small model, egress limited to `inference.do-ai.run`, and the
   tool policy as permissions (below).
3. Uploads the tar, extracts it in `/workspace`, and commits it there as a git baseline.
4. Sends the system prompt and prompt as one input (the harness has no system-prompt field), plus "end with a
   ```json block matching this schema" when the options carry a schema. Streams the events: tool calls go to
   `onStep`, the text after the last tool call is the answer, `run.completed` gives the cost.
5. `git add -A` in the sandbox, keeps only changed paths under `policy.writable`, downloads that patch, refuses
   symlinks, and `git apply`s it to the local worktree. Changes elsewhere are dropped and reported via `onStep`.
   This also happens when the run failed, like a local run that leaves its edits behind.
6. Parses the JSON answer (last ```json block, checking the schema's `required` keys) and removes the session
   and its saved config, also on failure.

The factory's own checks, limits and tests then run locally on the patched worktree, unchanged.

### The write policy, and what the platform can't enforce

| Local guard (`createToolGuard`) | On Managed Agents |
|---|---|
| Writes only under `writable` | **Enforced** by the patch filter: nothing outside `writable` comes back. Also `file.write` allow rules per prefix (best-effort on the platform) and `default: deny` |
| Bash only for `commands`, no chaining | `bash` allow rules for each command and `command *`, everything else denied. **Gap:** rules match globs literally, so `pnpm test; rm -rf x` matches `pnpm test *`. It can only hurt the throwaway sandbox, and its file changes still pass through the patch filter |
| Reads stay inside the repository | `file.read` is allowed everywhere in the sandbox, but the sandbox holds only the repository copy |
| No other tools | `default: deny` covers web fetch and the rest; egress allows only the inference host |
| `maxTurns` | No turn limit in the API: the run is cancelled after `maxTurns` tool calls |
| `maxBudgetUsd` | Cancelled when `run.cost_accrued` passes it |
| `outputFormat` JSON schema | No structured output: the answer is asked for as a ```json block and parsed |

The model key is in the agent's environment in the sandbox, as it is locally; the egress allowlist keeps it
from going anywhere but the inference endpoint.

## What it needs before it runs live

1. **A DigitalOcean personal access token** (`dop_v1_…`, created at https://cloud.digitalocean.com/account/api/tokens)
   in `factory/.env` as `DO_API_TOKEN`. Custom scopes: the Harness Runtime session scopes
   `agent_harness_session:create`, `:read`, `:update`, `:delete`, and the Environment Config delete scope if
   the token page lists it separately. For the hackathon, a Full Access token with a short expiry also works.
   The same token covers the App Platform deploys in section D if it also has `app:*`.
2. **A funded balance** on the team: the Serverless Inference balance Jarda already uses counts.
3. Then the proof, from `factory/`:

   ```bash
   MANAGED_LIVE=1 node --env-file-if-exists=.env --test --test-name-pattern=live tests/managed.test.ts
   ```

   It builds a scratch repo with a failing `node --test` test and a one-line bug, runs the fixer model on
   Managed Agents, and checks that the fix lands locally and the test passes.

## Open questions and gaps

- **Not verified live:** whether the `claude-code` harness honours `ANTHROPIC_DEFAULT_HAIKU_MODEL` (if it calls
  a Claude model for side tasks, Jarda's tier returns 403), whether `default: deny` with `match` rules behaves
  as documented for Claude Code, and the exact shape of `exec` output (assumed plain strings).
- **Node 20 in the sandbox:** the scraper's tests need Node 24 type stripping, and `node_modules` aren't
  uploaded, so the agent can't run `pnpm check` in the sandbox; the factory still runs it locally after the
  patch lands. Fix: a custom template (Harness Runtime `templates` API) with Node 24 and pnpm, plus
  `registry.npmjs.org` in egress.
- **Cost:** `costUsd` is the platform's `run_cost_micros`. The sandbox compute for a 5-minute run on
  `mars-2vcpu-4gb` is under $0.01 (memory ≈ $0.003, CPU mostly idle while the model thinks), so a run costs
  about the same as locally: the inference tokens.
- **Speed:** each run adds sandbox boot, upload and teardown (seconds to tens of seconds, not measured).
