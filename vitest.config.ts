import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      DATABASE_URL: 'postgres://ledger:ledger@localhost:5432/ledger_ai_test',
      SESSION_SECRET: 'test-session-secret-that-is-long-enough',
      APP_ENCRYPTION_KEY: 'test-encryption-secret-material',
    },
  },
});
