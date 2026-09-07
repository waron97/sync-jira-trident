# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Keep this file up to date.** Whenever this or a future session changes a command, env var, architecture decision, or file layout described below, update the relevant section in the same session — don't let this drift from the code.

## What this is

A CLI (`jirasync`, ESM Node project) that syncs Jira issues (project TESTML) into Trident (an Odoo instance) as `project.task` records: creates new tasks for matching Jira issues, reopens tasks whose Jira issue came back after being resolved/rejected, and mirrors new Jira comments (with inline images/attachments) onto the Trident task as `mail.message` notes.

## Commands

- `node src/index.js run [-o path]` — one-shot: fetch Jira issues, write them to `output.json` (or `-o`), create missing Trident tasks, then run the reopen + comment-sync update pass.
- `node src/index.js generate <JIRA-KEY>` — fetch a single Jira issue by key and create its Trident task if it doesn't already exist.
- `node src/index.js report [-o path]` — dry-run only, no Trident writes. Resolves assignee/cluster/sprint for every open TESTML ticket and writes `report.json` with per-ticket resolution method + a summary. Use this to sanity-check the allowlist/cluster mapping or to exercise the `claude -p` fallback path without touching Trident.
- `node src/index.js start [-o path]` — long-running: runs the create pass every 10 minutes, and the reopen + comment-sync pass every `UPDATE_INTERVAL_MINUTES` (default 30) over every existing task (no batching/cycling — Jira rate limits are handled by `fetchWithRetry`'s 429 backoff instead).
- No test suite or lint/build step is configured (`npm test` is a placeholder).

## Environment

Copy `.env.tpl` to `.env` (loaded via `dotenv` at the top of `src/index.js`). Values are 1Password references (`op://...`) resolved outside this script. Key vars: `JIRA_URL`/`JIRA_USER`/`JIRA_TOKEN`, `TRIDENT_URL`/`TRIDENT_DB`/`TRIDENT_TOKEN`, `TRIDENT_ID_*` (per-person Trident RPC identity — see below), `TRIDENT_SEVERITY_*`, `TRIDENT_PROJECT_ID`, `TRIDENT_STARTING_STAGE_ID`, `TRIDENT_RESOLVED_JIRA_STAGE_ID`, `TRIDENT_REJECTED_STAGE_ID`, `UPDATE_INTERVAL_MINUTES`, `GOOGLE_TOKEN`/`GOOGLE_REFRESH_TOKEN`. Two undocumented (not in `.env.tpl`) optional overrides: `CLAUDE_CONFIDENCE_THRESHOLD` (default `0.7`) and `CLAUDE_ASSIGNEE_CONFIDENCE_THRESHOLD` (default `0.9`) — see LLM fallback below. The `claude` CLI must be installed and already authenticated on the host (no API key env var) for the LLM fallback to work — an unauthenticated/missing CLI fails silently into "no match", same as any other fallback failure.

## Architecture

### Data flow (`src/commands/run.js`)

Jira issues are fetched (`util/jira.js`) and normalized (`normalizeIssue`) into a flat shape (title, description-as-HTML, assignee, priority, custom fields). For each issue:

1. **Resolve assignee** (`util/resolve.js: resolveAssignee`) against the Trident project's followers (`fetchProjectFollowers`) — exact name/login match → fuzzy Levenshtein match (`util/matching.js`, threshold 0.8) → LLM fallback. An issue with no resolvable assignee is **skipped entirely**, not created.
2. **Resolve cluster** (`resolveCluster`) — deterministic substring match against `x_cluster` names (`trident.js: matchCluster`) → LLM fallback if a "Processo di riferimento" custom field is present but nothing matched.
3. **Resolve ownership** — cluster's `x_owner_id` if the cluster resolved, else falls back to the assignee.
4. **Resolve/create sprint** — matches "priority week" custom field text (parsed by `resolve.js: parsePriorityWeek`, handles Italian date ranges) against `x_project_sprint` rows, creating a new sprint row if none matches (`run.js: resolveOrCreateSprint`; `report.js` uses the read-only `matchSprint` instead since it never writes).
5. Build the Trident payload (`buildTridentPayload`) and `create` the task, then upload issue attachments.

Comment sync (`syncComments`) is separate: for each already-existing Trident task (matched back to a Jira key via a `[KEY-123]` prefix in the task name), it diffs Jira comments against comments already posted (dedup via an idempotency footer `↪ Jira comment #<id>` parsed by `util/comments.js: extractSyncedCommentIds`), resolves any inline images/attachments in the comment body against Jira's attachment list (best-effort match by filename or by timestamp proximity — see `util/comments.js: matchAttachmentForMedia`), and posts new comments as batched `mail.message.create` calls (**not** `project.task.message_post`, which double-escapes HTML over this JSON-RPC path).

### LLM fallback (`src/util/claude.js`)

Both assignee and cluster resolution fall back to an LLM match (structured `{match, confidence}` result) only after the deterministic matchers fail. This shells out to the `claude` CLI in headless mode (`claude -p --model haiku --system-prompt ... --output-format json --json-schema ...`, `MAX_THINKING_TOKENS=0`) rather than calling a hosted API directly — no API key needed, relies on the `claude` CLI's own auth on the host. Uses `haiku` with extended thinking disabled specifically because this is a trivial one-shot classification, not an agentic task: `sonnet` with default thinking costs ~$0.12 and ~5s per call (mostly system-prompt cache creation + thinking tokens) since each invocation is a fresh CLI process with no cross-call prompt-cache reuse — untenable at hundreds of tickets per sync tick. The haiku/no-thinking config runs ~$0.01 and ~1.5-3s per call instead. The call is implemented with `child_process.spawn` (not `execFile`) with stdin explicitly set to `"ignore"` — `execFile` leaves the child's stdin open as an unclosed pipe, which makes the CLI stall ~3s waiting for stdin input before giving up. Any failure (CLI missing, non-zero exit, bad JSON) is swallowed and returns `{match: null, confidence: 0}`, so callers always get a value back and just treat it as "no match" via `meetsConfidence`/`meetsAssigneeConfidence`. Assignee matching uses a stricter confidence threshold than cluster matching — a wrong assignee match misroutes a real task to the wrong person.

### Trident RPC (`src/util/trident.js`)

All Trident access goes through one `callTrident(model, method, args, kwargs)` helper — Odoo's `execute_kw` JSON-RPC convention, authenticated as a fixed identity (`TRIDENT_ID_ARON` + `TRIDENT_TOKEN`), not per-user. `fetchClusters` passes `active_test: false` because most `x_cluster` rows are archived but still valid `x_cluster_id` targets. Writes/creates that can apply to many rows (`writeTridentTasks`, `createTridentAttachments`, `createComments`) are batched into as few RPC calls as possible.

### Scheduling (`src/index.js: start`)

The `start` command runs two independent `setInterval` loops: a 10-minute create-only tick and a `UPDATE_INTERVAL_MINUTES` reopen+comment-sync tick. Comment-sync checks every existing task every tick (one Jira comment-fetch call per task) — there is no batching/cycling; Jira rate limiting is absorbed entirely by `fetchWithRetry`'s 429 backoff (see below), which pauses and retries rather than skipping work.

### HTTP retry (`src/util/httpRetry.js`)

`fetchWithRetry` wraps `node-fetch` for both `jira.js` and `trident.js`: retries only on HTTP 429, honoring `Retry-After` when present, otherwise exponential backoff from 1s. Non-429 error responses are returned as-is for callers' existing `res.ok` handling.

### ADF → HTML (`src/util/jira.js: adfToHtml`)

Jira issue/comment bodies are Atlassian Document Format (ADF) JSON; `adfToHtml` recursively renders it to HTML for Trident's rich-text fields. Media nodes render differently depending on context: silently dropped when converting an issue description (no attachment-resolution context available there — the image still reaches Trident as a regular task attachment via `uploadIssueAttachments`), but rendered as `<img>`/download link or an explicit "not synced" placeholder when converting a comment body (where `resolveTaskCommentAttachments` has already tried to resolve it).
