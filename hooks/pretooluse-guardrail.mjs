#!/usr/bin/env node
// PreToolUse hook: before a Bash command runs, cheaply pre-filter for
// "high stakes" verbs (pushing code, deleting things, spending money,
// touching production). Only those get sent to Jev/Kev for a real risk
// judgment, so ordinary commands (npm test, ls, cat, ...) stay instant.
//
// Wire it up in settings.json:
//
//   {
//     "hooks": {
//       "PreToolUse": [
//         {
//           "matcher": "Bash",
//           "hooks": [
//             { "type": "command", "command": "node /absolute/path/to/jev-mcp/hooks/pretooluse-guardrail.mjs" }
//           ]
//         }
//       ]
//     }
//   }

import { readStdinJson, askJev, emit, failOpen } from "./lib.mjs";

const HIGH_STAKES_PATTERN =
  /\b(git\s+push|gh\s+pr\s+merge|npm\s+publish|yarn\s+publish|pnpm\s+publish|docker\s+push|kubectl\s+(delete|apply)|helm\s+(install|upgrade|uninstall)|terraform\s+(apply|destroy)|aws\s+\S+\s+(delete|terminate|create)|gcloud\s+\S+\s+delete|stripe\s+\S*(charge|refund|payout)|DROP\s+TABLE|DELETE\s+FROM|TRUNCATE\s+TABLE)\b/i;

const input = await readStdinJson();

if (input.tool_name !== "Bash") {
  process.exit(0); // this guardrail only reviews shell commands
}

const command = input.tool_input?.command ?? "";

if (!HIGH_STAKES_PATTERN.test(command)) {
  process.exit(0); // fast path: nothing that looks high-stakes, skip Jev entirely
}

try {
  const result = await askJev(command, {
    risk: {
      type: "choice",
      instructions:
        "An autonomous coding agent is about to run this shell command. How risky is it to run without a human double-checking first?",
      criteria: {
        safe: "Reversible, read-only, or affects only local/throwaway state",
        moderate: "Some real effect but recoverable (e.g. pushing to a feature branch, staging deploy)",
        dangerous: "Irreversible, deletes data, spends real money, or changes a shared/production system",
      },
    },
    needs_human: {
      type: "noul",
      instructions: "Should a human explicitly confirm before this specific command is allowed to run?",
    },
  });

  const risk = result.answers.risk;
  const needsHuman = result.answers.needs_human;

  const reasonLine =
    `jev guardrail: risk=${risk.choice} (confidence ${risk.confidence.toFixed(2)}), ` +
    `needs_human=${needsHuman.noul.toFixed(2)} — command: ${command}`;

  if (risk.choice === "dangerous" && risk.confidence >= 0.6) {
    emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reasonLine,
      },
    });
  } else if (needsHuman.noul >= 0.6 || risk.choice === "dangerous" || risk.choice === "moderate") {
    emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: reasonLine,
      },
    });
  }
  // else: safe enough — print nothing, exit 0, normal permission flow applies.
  process.exit(0);
} catch (err) {
  failOpen(err, "PreToolUse");
}
