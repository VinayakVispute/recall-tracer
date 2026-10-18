import { defineConfig } from 'vitest/config';

// Tests seed and write their own graph, so the demo graph (incidents, holds, memory, notices) is never touched. The MCP child inherits this env.
export default defineConfig({ test: { env: { RECALL_GRAPH: 'recall_test' } } });
