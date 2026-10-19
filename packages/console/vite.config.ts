import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: Vite serves the UI on :5173 and proxies websockets to the relay on :7331.
// Prod: `vite build` -> dist/, served by the relay itself at /.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:7331', ws: true },
      '/agent.js': 'http://localhost:7331',
      // Subresources of the debugged pages, fetched by those pages themselves.
      '/asset': 'http://localhost:7331',
      '/demo': 'http://localhost:7331',
    },
  },
});
