import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// App build config only. Test configuration lives in vitest.config.ts.
export default defineConfig({
  plugins: [react()],
});
