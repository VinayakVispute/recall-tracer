import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { schemas, tools } from '../tools/index.js';

const server = new McpServer({ name: 'recall-tracer', version: '0.1.0' });

for (const [name, { handler, description }] of Object.entries(tools)) {
  server.registerTool(name, { description, inputSchema: schemas[name as keyof typeof schemas] }, async (args: any) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(await handler(args)) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text' as const, text: String(e) }] };
    }
  });
}

await server.connect(new StdioServerTransport());
