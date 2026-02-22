#!/usr/bin/env npx tsx
import "dotenv/config";
import { tools } from "./news.skill";

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

(async () => {
  try {
    const result = await tool.handler(params as any);
    console.log(JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.log(JSON.stringify({
      error: err.message,
      code: err.code || "UNKNOWN",
      name: err.name,
    }));
    process.exit(0);
  }
})();
