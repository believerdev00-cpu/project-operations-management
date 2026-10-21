import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Both are needed by the login screen, so splitting them does not make
        // the first load smaller -- it makes it cache better. React changes on
        // a dependency upgrade, the four-language dictionary on almost every
        // wording commit, the app code in between; as one chunk, any of the
        // three re-downloaded all of them (and tripped Vite's 500 kB warning).
        manualChunks(id) {
          if (/[\/]node_modules[\/](react|react-dom|scheduler)[\/]/.test(id)) return 'react';
          if (/[\/]shared[\/]strings\.js$/.test(id)) return 'strings';
        }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:5000'
    }
  }
});
