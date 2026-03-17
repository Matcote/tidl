import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    environmentMatchGlobs: [
      ['tests/shared/utils.test.ts', 'jsdom'],
      ['tests/content.test.ts',      'jsdom'],
      ['tests/results.test.ts',      'jsdom'],
    ],
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup/chrome-mocks.ts', 'tests/setup/msw-server.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html'],
    },
  },
});
