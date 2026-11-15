import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    // テストから実際の AWS に到達しないよう、ダミーの認証情報で上書きする
    env: {
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      AWS_SESSION_TOKEN: 'test',
      AWS_REGION: 'ap-northeast-1',
      AWS_EC2_METADATA_DISABLED: 'true',
    },
  },
});
