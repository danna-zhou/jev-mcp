#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// --- Configuration -----------------------------------------------------
//
// JEV_BASE_URL: where the System One API lives.
//   - Local Kev server (default):        http://127.0.0.1:8009
//   - Real TypeSafe Jev API:              https://api.typesafe.ai
// JEV_API_KEY: bearer token. Kev ignores it unless KEV_API_KEY is set on
//   the server side. Jev requires a real key from console.typesafe.ai.
// JEV_MODEL: model name sent in each request. Defaults to "kev-latest"
//   which works for both Kev servers and (if pointed at Jev) is ignored
//   in favor of "jev-latest" — override explicitly when switching.
const BASE_URL = (process.env.JEV_BASE_URL ?? "http://127.0.0.1:8009").replace(/\/+$/, "");
const API_KEY = process.env.JEV_API_KEY ?? "local";
const DEFAULT_MODEL = process.env.JEV_MODEL ?? "kev-latest";

// --- Shared question schema (mirrors the System One API) ---------------
//
// Each question is one of:
//   choice: { type: "choice", instructions, criteria: { option: description|null } }
//   score:  { type: "score",  instructions, criteria: [level description, ...] }
//   noul:   { type: "noul",   instructions, criteria?: { true?, false? } }
const questionSchema = z
  .object({
    type: z.enum(["choice", "score", "noul"]),
    instructions: z.union([z.string(), z.record(z.any()), z.array(z.any())]).optional(),
    criteria: z.union([z.record(z.any()), z.array(z.any())]).optional(),
  })
  .passthrough();

const questionsSchema = z
  .record(z.string(), questionSchema)
  .describe(
    "Map of question id -> question definition. Mix as many choice/score/noul questions as needed; " +
      "each is evaluated independently against the same state in one request."
  );

const stateSchema = z
  .union([z.string(), z.record(z.any()), z.array(z.any())])
  .describe("The content to evaluate: plain text, or a JSON object/array that will be rendered as labeled text.");

interface SystemOneResponse {
  model: string;
  answers: Record<string, unknown>;
  usage?: { input_tokens: number; output_tokens: number };
  latency_ms?: number;
}

async function callSystemOne(state: unknown, questions: unknown, model: string): Promise<SystemOneResponse> {
  const res = await fetch(`${BASE_URL}/v1/systemone`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ state, model, questions }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`System One API returned ${res.status}: ${text}`);
  }

  return JSON.parse(text) as SystemOneResponse;
}

// --- MCP server ----------------------------------------------------------

const server = new McpServer({
  name: "jev-mcp",
  version: "0.1.0",
});

server.tool(
  "jev_ask",
  "Ask a Jev-compatible System One model (Jev or a local Kev server) one or more structured " +
    "questions about a piece of content. Use this instead of asking an LLM to 'return JSON' when " +
    "you need a reliable classification (choice), a rating (score), or a yes/no judgment (noul) " +
    "with a calibrated probability/confidence your code or workflow can branch on. Mix multiple " +
    "questions in one call; each is evaluated independently against the same state, so adding " +
    "questions barely changes latency and questions never see each other's context.",
  {
    state: stateSchema,
    questions: questionsSchema,
    model: z
      .string()
      .optional()
      .describe(`Model name to request. Defaults to "${DEFAULT_MODEL}" (env JEV_MODEL).`),
  },
  async ({ state, questions, model }) => {
    try {
      const result = await callSystemOne(state, questions, model ?? DEFAULT_MODEL);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `jev_ask failed: ${message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "jev_health",
  "Check whether the configured Jev-compatible System One endpoint (JEV_BASE_URL) is reachable, " +
    "and report which model(s) it is currently serving. Call this first if jev_ask calls are failing.",
  {},
  async () => {
    try {
      const res = await fetch(`${BASE_URL}/v1/models`, {
        headers: { authorization: `Bearer ${API_KEY}` },
      });
      const text = await res.text();
      if (!res.ok) {
        return {
          content: [{ type: "text" as const, text: `Endpoint ${BASE_URL} returned ${res.status}: ${text}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Endpoint ${BASE_URL} is reachable.\nDefault model: ${DEFAULT_MODEL}\n\n${text}`,
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Could not reach ${BASE_URL}: ${message}` }],
        isError: true,
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
