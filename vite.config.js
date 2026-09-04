import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: ['sb-55u734ytsjlr.vercel.run'],
    proxy: {
      '/api': 'http://localhost:5003'
    }
  }
});
