// Shared helpers for Claude Code hook scripts that consult a Jev-compatible
// System One endpoint (Jev itself, or a local Kev server) before letting an
// agent act or finish responding.
//
// Config comes from the same env vars as the MCP server (src/index.ts):
//   JEV_BASE_URL  - default http://127.0.0.1:8009 (local Kev)
//   JEV_API_KEY   - default "local"
//   JEV_MODEL     - default "kev-latest"

const BASE_URL = (process.env.JEV_BASE_URL ?? "http://127.0.0.1:8009").replace(/\/+$/, "");
const API_KEY = process.env.JEV_API_KEY ?? "local";
const MODEL = process.env.JEV_MODEL ?? "kev-latest";

/** Read and parse the JSON payload Claude Code sends on stdin for a hook. */
export async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

/** Call POST /v1/systemone with a short timeout; throws on failure. */
export async function askJev(state, questions, { model = MODEL, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ state, model, questions }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`System One API returned ${res.status}: ${text}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/** Print a JSON hook decision to stdout (Claude Code reads this on exit 0). */
export function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

/**
 * Fail-open helper: if the Jev/Kev endpoint is unreachable, don't block the
 * agent — just warn and let the normal flow continue. Change this if you'd
 * rather fail closed (e.g. deny Bash calls when the guardrail can't reach
 * its judge).
 */
export function failOpen(err, hookEventName) {
  emit({
    hookSpecificOutput: {
      hookEventName,
      additionalContext: `jev guardrail: could not reach ${BASE_URL} (${err.message}); skipping review.`,
    },
    systemMessage: `jev guardrail unreachable, skipping review: ${err.message}`,
  });
  process.exit(0);
}
