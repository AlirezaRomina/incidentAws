/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5317, strictPort: false },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
