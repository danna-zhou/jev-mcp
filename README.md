# jev-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude Code (or any
MCP-compatible agent) call a **Jev-compatible System One API** during a
task — for classification (`choice`), rating (`score`), or yes/no judgments
(`noul`) with calibrated probabilities, instead of asking an LLM to "return
JSON" and hoping it parses.

It works against either:

- **[TypeSafe's Jev](https://docs.typesafe.ai)** — the hosted model, or
- **[Kev](https://github.com/jaredpalmer/kev)** — an open-source, self-hosted,
  API-compatible replacement you can run locally for free.

Both speak the same `POST /v1/systemone` shape, so switching between them is
just an environment variable.

## Tools

| Tool | Purpose |
| --- | --- |
| `jev_ask` | Send a `state` (text/JSON) plus one or more `questions` (`choice`/`score`/`noul`), get back structured, calibrated answers. |
| `jev_health` | Check that the configured endpoint is reachable and see which model it's serving. Useful for debugging. |

### Example `jev_ask` call

```json
{
  "state": "Shoes arrived two weeks late and in the wrong size. Also two duplicate charges on my card.",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": {
        "returns": "Exchanges, refunds, wrong or damaged items",
        "shipping": "Delivery status, delays, lost packages",
        "billing": "Charges, invoices, payment problems"
      }
    },
    "escalate": {
      "type": "noul",
      "instructions": "Does this need urgent human attention?"
    },
    "frustration": {
      "type": "score",
      "instructions": "How frustrated is the customer?",
      "criteria": ["Calm", "Frustrated", "Very angry"]
    }
  }
}
```

Returns typed answers with per-option probabilities and confidence — see
[TypeSafe's API reference](https://docs.typesafe.ai/api) for the full
response shape (Kev mirrors it exactly).

## Setup

### 1. Run a backend

**Option A — local Kev (free, no API key, runs on your machine):**

```bash
git clone https://github.com/jaredpalmer/kev.git
cd kev
uv sync --extra serve
uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009
```

**Option B — hosted Jev:**

Get an API key from [console.typesafe.ai/keys](https://console.typesafe.ai/keys).

### 2. Build this server

```bash
git clone https://github.com/danna-zhou/jev-mcp.git
cd jev-mcp
npm install
npm run build
```

### 3. Register it with Claude Code

```bash
claude mcp add jev -- node /absolute/path/to/jev-mcp/dist/index.js
```

To point at local Kev (default), no extra config is needed. To point at
hosted Jev instead:

```bash
claude mcp add jev \
  -e JEV_BASE_URL=https://api.typesafe.ai \
  -e JEV_API_KEY=sk-your-real-key \
  -e JEV_MODEL=jev-latest \
  -- node /absolute/path/to/jev-mcp/dist/index.js
```

Restart Claude Code (or run `/mcp` to check connection status). Claude can
now call `jev_ask` and `jev_health` mid-task.

## Guardrail hooks (optional)

The MCP tools above are *passive* — Claude decides on its own whether to call
them. If you want Jev/Kev to sit in the loop as a **mandatory** check before
specific things happen, use Claude Code's [hooks](https://docs.claude.com/en/docs/claude-code/hooks)
instead. Two are included under `hooks/`:

| Script | Hook event | What it does |
| --- | --- | --- |
| `hooks/pretooluse-guardrail.mjs` | `PreToolUse` (matcher: `Bash`) | Cheaply pre-filters for high-stakes shell commands (`git push`, `terraform apply`, `DROP TABLE`, payment/cloud-delete calls, ...). Only those get sent to Jev for a risk judgment; everything else is a fast no-op. Denies commands Jev is confident are dangerous, asks for human confirmation on anything moderate/uncertain. |
| `hooks/stop-guardrail.mjs` | `Stop` | Before Claude ends a turn, sends its final response to Jev for a quick "does this look complete and safe to hand back?" check. If Jev isn't confident, blocks the stop once and tells Claude why, so it gets one automatic chance to fix itself. |

Both scripts call the System One endpoint directly over HTTP (same
`JEV_BASE_URL`/`JEV_API_KEY`/`JEV_MODEL` env vars as the MCP server) and
**fail open**: if the endpoint is unreachable, they warn and let the agent
proceed rather than blocking everything.

### Enable them

Add to `~/.claude/settings.json` (all projects) or `.claude/settings.json`
(one project):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node /absolute/path/to/jev-mcp/hooks/pretooluse-guardrail.mjs" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node /absolute/path/to/jev-mcp/hooks/stop-guardrail.mjs" }
        ]
      }
    ]
  }
}
```

### Test a hook script directly

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"git push origin main --force"}}' \
  | node hooks/pretooluse-guardrail.mjs

echo '{"last_assistant_message":"Fixed it, but I didn'"'"'t run the tests yet.","stop_hook_active":false}' \
  | node hooks/stop-guardrail.mjs
```

Tune the risk patterns, questions, and thresholds directly in the scripts —
they're plain, dependency-free Node (`hooks/lib.mjs` has the shared HTTP
call), not something you need to rebuild.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `JEV_BASE_URL` | `http://127.0.0.1:8009` | Base URL of the System One API (local Kev by default). |
| `JEV_API_KEY` | `local` | Bearer token. Ignored by Kev unless `KEV_API_KEY` is set server-side; required for hosted Jev. |
| `JEV_MODEL` | `kev-latest` | Default `model` field sent with each request. Use `jev-latest` when pointed at hosted Jev. |

## Development

```bash
npm run dev     # tsc --watch
npm run build   # one-off compile to dist/
```

Manual smoke test over stdio (no MCP client needed):

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.0.1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node dist/index.js
```

## Why not just prompt an LLM?

See [TypeSafe's docs](https://docs.typesafe.ai/introduction) — the short
version: LLMs are trained to please humans (RLHF) and generate free text.
Asking one to "return JSON" for a classification/rating/yes-no decision
means parsing risk, uncalibrated confidence, and context bleed between
questions. Jev/Kev are trained specifically to return typed, calibrated
answers your code (or agent workflow) can branch on directly.

## License

MIT
