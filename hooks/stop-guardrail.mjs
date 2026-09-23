#!/usr/bin/env node
// Stop hook: "quality dashboard" mode. Every time Claude finishes a turn,
// send its final response to Jev/Kev for a quality score and an accuracy
// score. This is display-only — it never blocks the turn from ending.
//
// Scores are:
//   - shown to you via systemMessage (visible in the Claude Code transcript)
//   - appended as JSONL to ~/.claude/jev-quality-log.jsonl so you can review
//     trends later, not just see a score flash by once.
//
// Wire it up in settings.json:
//
//   {
//     "hooks": {
//       "Stop": [
//         { "hooks": [ { "type": "command", "command": "node /absolute/path/to/jev-mcp/hooks/stop-guardrail.mjs" } ] }
//       ]
//     }
//   }
//
// Want it to also block low-scoring turns instead of just displaying them?
// See the commented-out block at the bottom — flip SHOULD_BLOCK on and set
// a threshold.

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { readStdinJson, askJev, emit, failOpen } from "./lib.mjs";

/** Best-effort macOS notification, independent of whatever chat UI is in front. */
function notify(title, message) {
  if (process.platform !== "darwin") return;
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  execFile("osascript", ["-e", script], () => {
    /* ignore failures — this is a best-effort side channel */
  });
}

const LOG_PATH = process.env.JEV_QUALITY_LOG ?? path.join(os.homedir(), ".claude", "jev-quality-log.jsonl");
const SHOULD_BLOCK = false; // dashboard mode: score everything, block nothing

const input = await readStdinJson();

// Avoid double-scoring the same turn if some other Stop hook is already
// forcing a continuation.
if (input.stop_hook_active) {
  process.exit(0);
}

const message = (input.last_assistant_message ?? "").trim();

if (!message) {
  process.exit(0); // nothing to score
}

try {
  const result = await askJev(message, {
    quality: {
      type: "score",
      instructions:
        "Rate the overall quality of this AI assistant response: clarity, structure, and how helpful/usable " +
        "it is as-is.",
      criteria: [
        "Poor — unclear, unhelpful, or poorly structured",
        "Adequate — reasonably clear and helpful",
        "Excellent — clear, well-structured, directly useful",
      ],
    },
    accuracy: {
      type: "score",
      instructions:
        "Judging only from internal consistency and what's stated in the response (you cannot verify external " +
        "facts), how likely is this response to be accurate and logically sound, with no apparent errors or " +
        "contradictions?",
      criteria: [
        "Likely contains errors, contradictions, or unsupported claims",
        "Mostly sound, minor concerns",
        "Highly likely accurate and logically consistent",
      ],
    },
  });

  const quality = result.answers.quality;
  const accuracy = result.answers.accuracy;

  const summary =
    `jev quality: ${quality.score.toFixed(2)}/2 (conf ${quality.confidence.toFixed(2)})  |  ` +
    `accuracy: ${accuracy.score.toFixed(2)}/2 (conf ${accuracy.confidence.toFixed(2)})`;

  // Append to the local log so scores accumulate into a reviewable history.
  const logLine =
    JSON.stringify({
      ts: new Date().toISOString(),
      session_id: input.session_id,
      cwd: input.cwd,
      quality_score: quality.score,
      quality_confidence: quality.confidence,
      accuracy_score: accuracy.score,
      accuracy_confidence: accuracy.confidence,
      message_preview: message.slice(0, 200),
    }) + "\n";
  await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
  await fs.appendFile(LOG_PATH, logLine, "utf8");

  // NOTE: hookSpecificOutput.additionalContext on the Stop event forces
  // Claude to keep going for another turn (same continuation mechanism as
  // decision: "block", just labeled differently) — not what we want for a
  // display-only dashboard. systemMessage is the only non-blocking, visible
  // channel Stop supports, and whether your specific Claude Code client
  // renders it is client-dependent. So we also fire a native OS notification
  // (macOS only, best-effort) as a channel that's independent of the chat
  // UI entirely. The JSONL log is the one source of truth regardless of any
  // of this — see JEV_QUALITY_LOG.
  emit({ systemMessage: summary });
  notify("jev guardrail", summary);

  // --- Optional: flip this on to also block low-scoring turns -----------
  // if (SHOULD_BLOCK && (quality.score < 1 || accuracy.score < 1)) {
  //   emit({
  //     decision: "block",
  //     reason: `${summary} — quality/accuracy too low, please revise before finishing.`,
  //   });
  // }
  // ------------------------------------------------------------------------

  process.exit(0);
} catch (err) {
  failOpen(err, "Stop");
}
