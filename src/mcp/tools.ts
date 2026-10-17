import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { schemas, tools } from '../tools/index.js';
import { measure } from '../graph/db.js';

/** Registers every tool on an MCP server; shared by the stdio server and the HTTP `/mcp` route. */
export function registerTools(server: McpServer) {
  for (const [name, { handler, description }] of Object.entries(tools)) {
    server.registerTool(name, { description, inputSchema: z.object(schemas[name as keyof typeof schemas]) }, async (args: any) => {
      try {
        const { result, db_ms, queries } = await measure<object>(() => handler(args));
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ...result, db_ms, queries }) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: String(e) }] };
      }
    });
  }
}
