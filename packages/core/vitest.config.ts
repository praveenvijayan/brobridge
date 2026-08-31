import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'core',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary'],
      // PROTOCOL.md is only as good as the code that implements it, so the
      // three modules carrying the wire contract keep a hard floor.
      thresholds: {
        'src/codec.ts': { lines: 90 },
        'src/mux.ts': { lines: 90 },
        'src/resume.ts': { lines: 90 },
      },
    },
  },
});
