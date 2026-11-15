import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// GitHub Pages などのサブパスに置くときは BASE_PATH=/<repo>/ を渡す
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
