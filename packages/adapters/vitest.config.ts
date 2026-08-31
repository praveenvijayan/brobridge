import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'adapters',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
