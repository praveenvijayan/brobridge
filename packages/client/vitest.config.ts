import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'client',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
