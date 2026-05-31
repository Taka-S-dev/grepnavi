#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BRIDGE_VERSION, grepnaviBaseUrl } from "./shared.js";
import type { ToolDef, ToolHandler } from "./shared.js";
import * as meta from "./tools/meta.js";
import * as search from "./tools/search.js";
import * as graph from "./tools/graph.js";
import * as memo from "./tools/memo.js";

const server = new Server(
  { name: "grepnavi-mcp", version: BRIDGE_VERSION },
  { capabilities: { tools: {} } },
);

const tools: ToolDef[] = [
  ...meta.definitions,
  ...search.definitions,
  ...graph.definitions,
  ...memo.definitions,
];

const handlers: Record<string, ToolHandler> = {
  ...meta.handlers,
  ...search.handlers,
  ...graph.handlers,
  ...memo.handlers,
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const handler = handlers[name];
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    return (await handler(args)) as { content: Array<{ type: string; text: string }> };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${msg}` }],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`grepnavi-mcp ready (base=${grepnaviBaseUrl})\n`);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err}\n`);
  process.exit(1);
});
