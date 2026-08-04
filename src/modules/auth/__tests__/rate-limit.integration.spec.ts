import type { Server } from 'node:http';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp, SEEDED_ADMIN } from '../../../../test/create-test-app';

/**
 * The one suite that runs with rate limiting ACTIVE.
 *
 * Every other integration suite disables it, so without this file the login
 * throttle would ship untested — and a misconfigured throttler fails silently.
 * That is exactly what happened during development: the @Throttle() override
 * named a throttler that did not exist, so it did nothing at all.
 */
describe('Login rate limiting (integration)', () => {
  let app: INestApplication;
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await createTestApp({ throttling: true });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('blocks the 6th login attempt within a minute with 429', async () => {
    const attempt = () =>
      request(server())
        .post('/api/auth/login')
        .send({ email: SEEDED_ADMIN.email, password: 'DeliberatelyWrong1!' });

    const statuses: number[] = [];

    for (let i = 0; i < 7; i++) {
      const response = await attempt();
      statuses.push(response.status);
    }

    // First five are ordinary auth failures; the rest are throttled.
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});
