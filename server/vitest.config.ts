import { defineConfig } from 'vitest/config';

const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/istam_test',
  APP_DB_USER: 'istam_app',
  APP_DB_PASSWORD: process.env.TEST_APP_DB_PASSWORD ?? 'dev_app_pw_123',
  APP_DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? 'postgres://istam_app:dev_app_pw_123@127.0.0.1:5433/istam_test',
  JWT_SECRET: 'test-secret-test-secret-test-secret-123',
  ADMIN_LOGIN: 'admin',
  ADMIN_PASSWORD: 'Admin12345',
};
// globalSetup asosiy jarayonda ishlaydi, shuning uchun bu yerda ham o'rnatamiz
Object.assign(process.env, TEST_ENV);

export default defineConfig({
  test: {
    globalSetup: ['./test/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    env: TEST_ENV,
  },
});
