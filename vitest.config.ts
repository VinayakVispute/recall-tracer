import { defineConfig } from 'vitest/config';

// Keep test drafts out of the demo's out/notices.json; the MCP child inherits this env.
export default defineConfig({ test: { env: { NOTICES_FILE: 'out/test-notices.json' } } });
