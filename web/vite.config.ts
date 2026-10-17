import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = 'http://localhost:8787';
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/recall': api, '/graph': api, '/notices': api, '/export': api, '/incident': api } },
});
