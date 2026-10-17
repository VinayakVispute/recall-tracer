import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { registerTools } from './tools.js';

const server = new McpServer({ name: 'recall-tracer', version: '0.1.0' });
registerTools(server);
await server.connect(new StdioServerTransport());
