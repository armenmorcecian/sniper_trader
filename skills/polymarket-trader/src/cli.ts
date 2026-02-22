#!/usr/bin/env npx tsx
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");
import "dotenv/config";
import { tools } from "./polymarket.skill";
import { recordToolCall } from "quant-core";
import type { ToolCallEntry } from "quant-core";

const toolName = process.argv[2];
const paramsJson = process.argv[3] || "{}";

if (!toolName) {
  console.log(JSON.stringify({
    error: "Usage: npx tsx src/cli.ts <tool_name> [json_params]",
    available: tools.map(t => t.name),
  }));
  process.exit(1);
}

const tool = tools.find(t => t.name === toolName);
if (!tool) {
  console.log(JSON.stringify({
    error: `Unknown tool: ${toolName}`,
    available: tools.map(t => t.name),
  }));
  process.exit(1);
}

let params: Record<string, unknown>;
try {
  params = JSON.parse(paramsJson);
} catch {
  console.log(JSON.stringify({ error: `Invalid JSON params: ${paramsJson}` }));
  process.exit(1);
}

function summarizeResult(result: unknown): string {
  if (!result || typeof result !== "object") return String(result);
  const r = result as Record<string, unknown>;
  const keys = Object.keys(r);
  const summary: Record<string, unknown> = {};
  for (const key of keys.slice(0, 8)) {
    const val = r[key];
    if (Array.isArray(val)) summary[key] = `[${val.length} items]`;
    else if (typeof val === "object" && val !== null) summary[key] = "{...}";
    else summary[key] = val;
  }
  const str = JSON.stringify(summary);
  return str.length > 500 ? str.slice(0, 497) + "..." : str;
}

function retryRecordToolCall(entry: ToolCallEntry, attempts = 3): void {
  for (let i = 0; i < attempts; i++) {
    try {
      recordToolCall(entry);
      return;
    } catch (err) {
      if (i === attempts - 1) {
        console.warn(`[${entry.skill}] recordToolCall failed after ${attempts} attempts: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

(async () => {
  const startMs = Date.now();
  try {
    const result = await tool.handler(params as any);
    const latencyMs = Date.now() - startMs;
    retryRecordToolCall({
      skill: "polymarket",
      tool: toolName,
      params: params as Record<string, unknown>,
      resultSummary: summarizeResult(result),
      latencyMs,
      status: (result as Record<string, unknown>)?.error ? "error" : "ok",
      error: (result as Record<string, unknown>)?.error ? String((result as Record<string, unknown>).error) : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (err: any) {
    const latencyMs = Date.now() - startMs;
    retryRecordToolCall({
      skill: "polymarket",
      tool: toolName,
      params,
      latencyMs,
      status: "error",
      error: err.message,
    });
    console.log(JSON.stringify({
      error: err.message,
      code: err.code || "UNKNOWN",
      name: err.name,
    }));
    process.exit(0);
  }
})();
