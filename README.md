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
