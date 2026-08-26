import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import type { Response } from 'supertest';

import { createTestApp, SEEDED_ADMIN } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';

const ENDPOINT = '/api/webhooks/user-registration';
const EVENTS_ENDPOINT = '/api/webhooks/events';

const SUPPORT_ADMIN = {
  email: 'support.webhooks@bjspades.com',
  password: 'Support123!',
};

interface LoginBody {
  data: { accessToken: string };
}

interface AckBody {
  success: boolean;
  data: {
    eventId: string;
    status: 'PROCESSED' | 'DUPLICATE' | 'FAILED';
    userId?: string;
    reason?: string;
  };
}

interface ErrorBody {
  success: false;
  error: { code: string; message: string };
}

const secret = (): string => {
  const value = process.env.WEBHOOK_SECRET;

  if (!value) {
    throw new Error('WEBHOOK_SECRET missing — is .env.test loaded?');
  }

  return value;
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function sign(timestamp: number, rawBody: string, key = secret()): string {
  return createHmac('sha256', key)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}

function bodyFor(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: 'user.registration',
    data: {
      fullName: 'David Kim',
      email: 'david.kim@email.com',
      mobileNumber: '+15555551234',
      tier: 'PREMIUM',
      addressLine1: '123 Main St',
      city: 'New York',
      state: 'NY',
      postalCode: '10001',
      country: 'United States',
      ...overrides,
    },
  });
}

interface SendOptions {
  /** The exact bytes to send. Signed as-is unless `signedBody` overrides it. */
  rawBody: string;
  /** Sign this instead — used to simulate tampering. */
  signedBody?: string;
  timestamp?: number;
  eventId?: string | null;
  source?: string;
  signatureHeader?: string | null;
  key?: string;
}

describe('Webhooks (integration)', () => {
  let app: INestApplication;

  const server = (): Server => app.getHttpServer() as Server;

  const send = (options: SendOptions): request.Test => {
    const timestamp = options.timestamp ?? nowSeconds();
    const signed = options.signedBody ?? options.rawBody;

    const call = request(server())
      .post(ENDPOINT)
      .set('Content-Type', 'application/json');

    if (options.signatureHeader !== null) {
      call.set(
        'X-BJS-Signature',
        options.signatureHeader ??
          `sha256=${sign(timestamp, signed, options.key)}`,
      );
    }

    call.set('X-BJS-Timestamp', String(timestamp));

    if (options.eventId !== null) {
      call.set('X-BJS-Event-Id', options.eventId ?? `evt_${randomUUID()}`);
    }

    call.set('X-BJS-Source', options.source ?? 'bjspades-signup-form');

    return call.send(options.rawBody);
  };

  const tokenFor = async (credentials: {
    email: string;
    password: string;
  }): Promise<string> => {
    const response = await request(server())
      .post('/api/auth/login')
      .send(credentials);

    if (response.status !== 200) {
      throw new Error(
        `login expected 200, got ${response.status}: ${JSON.stringify(response.body)}`,
      );
    }

    return (response.body as LoginBody).data.accessToken;
  };

  beforeAll(async () => {
    app = await createTestApp();

    const supportRole = await testPrisma.role.findUniqueOrThrow({
      where: { name: 'SUPPORT' },
    });

    const password = await bcrypt.hash(SUPPORT_ADMIN.password, 10);

    await testPrisma.admin.upsert({
      where: { email: SUPPORT_ADMIN.email },
      update: { password, roleId: supportRole.id, isActive: true },
      create: {
        firstName: 'Webhook',
        lastName: 'Support',
        email: SUPPORT_ADMIN.email,
        password,
        roleId: supportRole.id,
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    await testPrisma.admin.deleteMany({
      where: { email: SUPPORT_ADMIN.email },
    });
    await app?.close();
  });

  describe('POST /webhooks/user-registration', () => {
    it('creates an ACTIVE webhook-sourced user and returns 200', async () => {
      const eventId = `evt_${randomUUID()}`;
      const rawBody = bodyFor();

      const response = await send({ rawBody, eventId }).expect(200);

      const body = response.body as AckBody;

      expect(body.success).toBe(true);
      expect(body.data.status).toBe('PROCESSED');
      expect(body.data.eventId).toBe(eventId);
      expect(body.data.userId).toEqual(expect.any(String));

      // Re-query: the response is not evidence that anything was written.
      const user = await testPrisma.user.findUniqueOrThrow({
        where: { email: 'david.kim@email.com' },
      });

      expect(user.source).toBe('WEBHOOK');
      expect(user.status).toBe('ACTIVE');
      expect(user.tier).toBe('PREMIUM');
      expect(user.firstName).toBe('David');
      expect(user.lastName).toBe('Kim');
      expect(user.phone).toBe('+15555551234');
      expect(user.city).toBe('New York');
      expect(user.id).toBe(body.data.userId);

      const event = await testPrisma.webhookEvent.findUniqueOrThrow({
        where: { eventId },
      });

      expect(event.status).toBe('PROCESSED');
      expect(event.type).toBe('user.registration');
      expect(event.source).toBe('bjspades-signup-form');
      expect(event.processedAt).not.toBeNull();
      expect(user.webhookEventId).toBe(event.id);
    });

    /**
     * THE regression test for raw-body capture.
     *
     * The body below has its keys in a non-obvious order and is pretty-printed.
     * Whatever Nest's JSON parser produces and re-serialises will have neither
     * property, so a signature checked against `request.body` cannot match.
     * Delete the raw-body middleware and this test fails immediately.
     */
    it('verifies a signature over a payload whose JSON keys are in a different order', async () => {
      const eventId = `evt_${randomUUID()}`;

      const rawBody = [
        '{',
        '  "data": {',
        '    "tier": "VIP",',
        '    "country": "United States",',
        '    "email": "reordered.keys@email.com",',
        '    "fullName": "Reordered Keys"',
        '  },',
        '  "event": "user.registration"',
        '}',
      ].join('\n');

      const response = await send({ rawBody, eventId }).expect(200);

      expect((response.body as AckBody).data.status).toBe('PROCESSED');

      const user = await testPrisma.user.findUniqueOrThrow({
        where: { email: 'reordered.keys@email.com' },
      });

      expect(user.tier).toBe('VIP');
      expect(user.source).toBe('WEBHOOK');
      expect(user.status).toBe('ACTIVE');
    });

    it('treats the same event id as a duplicate and creates exactly one user', async () => {
      const eventId = `evt_${randomUUID()}`;
      const rawBody = bodyFor();

      const first = await send({ rawBody, eventId }).expect(200);
      const second = await send({ rawBody, eventId }).expect(200);

      const firstBody = first.body as AckBody;
      const secondBody = second.body as AckBody;

      expect(firstBody.data.status).toBe('PROCESSED');
      expect(secondBody.data.status).toBe('DUPLICATE');
      expect(secondBody.data.userId).toBe(firstBody.data.userId);

      expect(await testPrisma.user.count()).toBe(1);
      expect(await testPrisma.webhookEvent.count()).toBe(1);
    });

    it('creates exactly one user when identical requests race', async () => {
      const eventId = `evt_${randomUUID()}`;
      const rawBody = bodyFor();

      const responses = await Promise.all([
        send({ rawBody, eventId }),
        send({ rawBody, eventId }),
        send({ rawBody, eventId }),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(200);
      }

      const statuses = responses.map((r) => (r.body as AckBody).data.status);

      // The unique index on eventId is what makes this a database guarantee
      // rather than a check-then-act with a window in the middle.
      expect(statuses.filter((s) => s === 'PROCESSED')).toHaveLength(1);
      expect(await testPrisma.user.count()).toBe(1);
      expect(await testPrisma.webhookEvent.count()).toBe(1);
    });

    it('rejects a tampered body with 401', async () => {
      const rawBody = bodyFor();
      const tampered = rawBody.replace('David Kim', 'Mallory Kim');

      const response = await send({
        rawBody: tampered,
        signedBody: rawBody,
      }).expect(401);

      expect((response.body as ErrorBody).error.code).toBe('INVALID_SIGNATURE');
      expect(await testPrisma.user.count()).toBe(0);
      expect(await testPrisma.webhookEvent.count()).toBe(0);
    });

    it('rejects a timestamp ten minutes old with 401', async () => {
      await send({
        rawBody: bodyFor(),
        timestamp: nowSeconds() - 600,
      }).expect(401);

      expect(await testPrisma.webhookEvent.count()).toBe(0);
    });

    it('rejects a missing signature header with 401', async () => {
      const response = await send({
        rawBody: bodyFor(),
        signatureHeader: null,
      }).expect(401);

      // Identical message to every other 401: which check failed is not the
      // sender's business.
      expect((response.body as ErrorBody).error.message).toBe(
        'Signature verification failed',
      );
      expect(await testPrisma.webhookEvent.count()).toBe(0);
    });

    it('rejects a signature made with the wrong secret with 401', async () => {
      await send({ rawBody: bodyFor(), key: 'not-the-real-secret' }).expect(
        401,
      );

      expect(await testPrisma.webhookEvent.count()).toBe(0);
    });

    it('stores an invalid payload as FAILED and still returns 200', async () => {
      const eventId = `evt_${randomUUID()}`;

      // fullName below the 2-character minimum, and no email at all.
      const rawBody = JSON.stringify({
        event: 'user.registration',
        data: { fullName: 'D' },
      });

      const response = await send({ rawBody, eventId }).expect(200);

      const body = response.body as AckBody;

      expect(body.data.status).toBe('FAILED');
      expect(body.data.reason).toEqual(expect.any(String));

      const event = await testPrisma.webhookEvent.findUniqueOrThrow({
        where: { eventId },
      });

      expect(event.status).toBe('FAILED');
      expect(event.errorMessage).toEqual(expect.any(String));
      // The whole point of persisting before validating: the payload survives.
      expect(event.payload).toEqual({
        event: 'user.registration',
        data: { fullName: 'D' },
      });

      expect(await testPrisma.user.count()).toBe(0);
    });

    it('stores a wrong event type as FAILED', async () => {
      const eventId = `evt_${randomUUID()}`;
      const rawBody = JSON.stringify({
        event: 'user.deletion',
        data: { fullName: 'David Kim', email: 'david.kim@email.com' },
      });

      const response = await send({ rawBody, eventId }).expect(200);

      expect((response.body as AckBody).data.status).toBe('FAILED');

      const event = await testPrisma.webhookEvent.findUniqueOrThrow({
        where: { eventId },
      });

      expect(event.status).toBe('FAILED');
      expect(event.type).toBe('user.deletion');
    });

    it('returns 200 FAILED when the email is already registered', async () => {
      const rawBody = bodyFor();

      await send({ rawBody }).expect(200);

      // Second delivery, fresh event id, same email.
      const response = await send({ rawBody }).expect(200);
      const body = response.body as AckBody;

      expect(body.data.status).toBe('FAILED');
      expect(body.data.reason).toBe('Email already registered');

      expect(await testPrisma.user.count()).toBe(1);
      expect(await testPrisma.webhookEvent.count()).toBe(2);
    });

    it('keeps malformed JSON as a FAILED event rather than 400ing', async () => {
      const eventId = `evt_${randomUUID()}`;
      const rawBody = '{"event": "user.registration", "data": {';

      const response = await send({ rawBody, eventId }).expect(200);

      expect((response.body as AckBody).data.status).toBe('FAILED');

      const event = await testPrisma.webhookEvent.findUniqueOrThrow({
        where: { eventId },
      });

      expect(event.status).toBe('FAILED');
      expect(event.payload).toEqual({ raw: rawBody });
    });

    it('ignores unknown fields instead of rejecting them', async () => {
      const rawBody = JSON.stringify({
        event: 'user.registration',
        data: {
          fullName: 'Future Field',
          email: 'future.field@email.com',
          referralCode: 'NOT-YET-SUPPORTED',
        },
        deliveryAttempt: 3,
      });

      const response = await send({ rawBody }).expect(200);

      expect((response.body as AckBody).data.status).toBe('PROCESSED');

      await expect(
        testPrisma.user.findUniqueOrThrow({
          where: { email: 'future.field@email.com' },
        }),
      ).resolves.toMatchObject({ source: 'WEBHOOK', tier: 'PLAYER' });
    });

    it('lower-cases the email on receipt', async () => {
      const rawBody = bodyFor({ email: 'David.KIM@Email.com' });

      await send({ rawBody }).expect(200);

      await expect(
        testPrisma.user.findUnique({ where: { email: 'david.kim@email.com' } }),
      ).resolves.not.toBeNull();
    });
  });

  describe('GET /webhooks/events', () => {
    const seedEvent = async (): Promise<void> => {
      await send({ rawBody: bodyFor() }).expect(200);
    };

    it('returns 401 without a token', async () => {
      await request(server()).get(EVENTS_ENDPOINT).expect(401);
    });

    it('returns 403 for an admin without security.manage', async () => {
      const token = await tokenFor(SUPPORT_ADMIN);

      await request(server())
        .get(EVENTS_ENDPOINT)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('returns paginated events for an admin with security.manage', async () => {
      await seedEvent();

      const token = await tokenFor(SEEDED_ADMIN);

      const response: Response = await request(server())
        .get(EVENTS_ENDPOINT)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as {
        success: boolean;
        data: { eventId: string; status: string; payload: unknown }[];
        meta: { total: number; page: number };
      };

      expect(body.success).toBe(true);
      expect(body.meta.total).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]?.status).toBe('PROCESSED');
      // The raw payload stays queryable through the API, not just the database.
      expect(body.data[0]?.payload).toMatchObject({
        event: 'user.registration',
      });
    });

    it('filters by status', async () => {
      await seedEvent();

      const failed = JSON.stringify({ event: 'user.registration', data: {} });
      await send({ rawBody: failed }).expect(200);

      const token = await tokenFor(SEEDED_ADMIN);

      const response = await request(server())
        .get(`${EVENTS_ENDPOINT}?status=FAILED`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as {
        data: { status: string }[];
        meta: { total: number };
      };

      expect(body.meta.total).toBe(1);
      expect(body.data.every((event) => event.status === 'FAILED')).toBe(true);
    });

    it('rejects an unknown sort field', async () => {
      const token = await tokenFor(SEEDED_ADMIN);

      await request(server())
        .get(`${EVENTS_ENDPOINT}?sortBy=createdAt`)
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });
  });

  describe('POST /webhooks/events/:id/retry', () => {
    it('reprocesses a failed event once the conflict is gone', async () => {
      const rawBody = bodyFor();

      await send({ rawBody }).expect(200);
      await send({ rawBody }).expect(200); // FAILED: duplicate email

      const failedEvent = await testPrisma.webhookEvent.findFirstOrThrow({
        where: { status: 'FAILED' },
      });

      // Clear the blocker the way an admin would before replaying.
      await testPrisma.user.deleteMany({
        where: { email: 'david.kim@email.com' },
      });

      const token = await tokenFor(SEEDED_ADMIN);

      const response = await request(server())
        .post(`${EVENTS_ENDPOINT}/${failedEvent.id}/retry`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((response.body as AckBody).data.status).toBe('PROCESSED');

      const replayed = await testPrisma.webhookEvent.findUniqueOrThrow({
        where: { id: failedEvent.id },
      });

      expect(replayed.status).toBe('PROCESSED');
      expect(replayed.attempts).toBe(2);
      expect(replayed.errorMessage).toBeNull();

      expect(await testPrisma.user.count()).toBe(1);
    });

    it('returns 409 for an already processed event', async () => {
      await send({ rawBody: bodyFor() }).expect(200);

      const event = await testPrisma.webhookEvent.findFirstOrThrow({
        where: { status: 'PROCESSED' },
      });

      const token = await tokenFor(SEEDED_ADMIN);

      await request(server())
        .post(`${EVENTS_ENDPOINT}/${event.id}/retry`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
    });

    it('returns 404 for an unknown event id', async () => {
      const token = await tokenFor(SEEDED_ADMIN);

      await request(server())
        .post(`${EVENTS_ENDPOINT}/${randomUUID()}/retry`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('returns 401 without a token', async () => {
      await request(server())
        .post(`${EVENTS_ENDPOINT}/${randomUUID()}/retry`)
        .expect(401);
    });

    it('returns 403 for an admin without security.manage', async () => {
      const token = await tokenFor(SUPPORT_ADMIN);

      await request(server())
        .post(`${EVENTS_ENDPOINT}/${randomUUID()}/retry`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });
  });
});
