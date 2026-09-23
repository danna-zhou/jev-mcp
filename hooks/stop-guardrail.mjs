#!/usr/bin/env node
// Stop hook: right before Claude ends its turn, send its final response to
// Jev/Kev for a quick sanity check ("does this look complete and safe to
// hand back as-is?"). If Jev is not confident, block the stop and tell
// Claude why, so it gets one automatic chance to fix itself.
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

import { readStdinJson, askJev, emit, failOpen } from "./lib.mjs";

const input = await readStdinJson();

// Avoid infinite loops: if we already blocked once this turn, don't block again.
if (input.stop_hook_active) {
  process.exit(0);
}

const message = input.last_assistant_message ?? "";

// Skip trivial/short responses — not worth a round trip to Jev.
if (message.trim().length < 40) {
  process.exit(0);
}

try {
  const result = await askJev(message, {
    looks_ok: {
      type: "noul",
      instructions:
        "This is an AI coding agent's final response for a turn. Does it look complete, and free of obvious " +
        "errors, unfinished work, or unaddressed parts of the user's request? Answer yes only if it looks safe " +
        "to hand back to the user as-is.",
    },
    completeness: {
      type: "score",
      instructions: "How completely does this response address what the user likely asked for?",
      criteria: ["Clearly missing something important", "Mostly complete, minor gaps", "Fully addresses it"],
    },
  });

  const looksOk = result.answers.looks_ok;
  const completeness = result.answers.completeness;

  const shouldBlock = looksOk.noul < 0.35 || (completeness.score < 1 && completeness.confidence >= 0.6);

  if (shouldBlock) {
    emit({
      decision: "block",
      reason:
        `jev guardrail flagged this response before finishing (looks_ok=${looksOk.noul.toFixed(2)}, ` +
        `completeness=${completeness.score.toFixed(2)}/2, confidence=${completeness.confidence.toFixed(2)}). ` +
        `Re-check the response for completeness and correctness before finishing this turn.`,
    });
  }
  process.exit(0);
} catch (err) {
  failOpen(err, "Stop");
}
