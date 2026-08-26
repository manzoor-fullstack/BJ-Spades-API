import type { Server } from 'node:http';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTestApp } from '../../../../test/create-test-app';
import { testPrisma } from '../../../../test/setup';

const ENDPOINT = '/api/webhooks/ghl/user-registration';

interface AckBody {
  success: boolean;
  data: {
    eventId: string;
    status: 'PROCESSED' | 'DUPLICATE' | 'FAILED';
    userId?: string;
    reason?: string;
  };
}

const token = (): string => {
  const value = process.env.GHL_WEBHOOK_TOKEN;

  if (!value) {
    throw new Error('GHL_WEBHOOK_TOKEN missing — is .env.test loaded?');
  }

  return value;
};

function contact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    contactId: 'ghl-contact-abc123',
    fullName: 'Ali Raza',
    email: 'ali.raza@example.com',
    mobileNumber: '+15555559876',
    tier: 'PREMIUM',
    city: 'Lahore',
    ...overrides,
  };
}

/**
 * Covers the wiring the unit tests cannot reach: that the route is registered
 * at this path, that @Public() and GhlTokenGuard cooperate rather than one
 * shadowing the other, and that a flat JSON body survives the raw-body
 * middleware mounted on /api/webhooks.
 */
describe('GoHighLevel registration webhook (integration)', () => {
  let app: INestApplication;

  const server = (): Server => app.getHttpServer() as Server;

  const send = (
    body: unknown,
    authorization: string | null = `Bearer ${token()}`,
  ): request.Test => {
    const call = request(server())
      .post(ENDPOINT)
      .set('Content-Type', 'application/json');

    if (authorization !== null) {
      call.set('Authorization', authorization);
    }

    return call.send(body as string | object);
  };

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('authentication', () => {
    it('rejects a request with no Authorization header', async () => {
      await send(contact(), null).expect(401);

      expect(await testPrisma.user.count()).toBe(0);
      expect(await testPrisma.webhookEvent.count()).toBe(0);
    });

    it('rejects a wrong token', async () => {
      await send(contact(), 'Bearer not-the-configured-token').expect(401);

      expect(await testPrisma.user.count()).toBe(0);
    });

    it('rejects the right token sent without the Bearer scheme', async () => {
      await send(contact(), token()).expect(401);

      expect(await testPrisma.user.count()).toBe(0);
    });
  });

  describe('successful registration', () => {
    it('creates a PENDING webhook-sourced user and returns 200', async () => {
      const response = await send(contact()).expect(200);

      const body = response.body as AckBody;

      expect(body.success).toBe(true);
      expect(body.data.status).toBe('PROCESSED');
      expect(body.data.eventId).toBe('ghl:ghl-contact-abc123');

      // Re-queried: the response is not evidence that anything was written.
      const user = await testPrisma.user.findUniqueOrThrow({
        where: { email: 'ali.raza@example.com' },
      });

      expect(user.source).toBe('WEBHOOK');
      expect(user.status).toBe('PENDING');
      expect(user.tier).toBe('PREMIUM');
      expect(user.firstName).toBe('Ali');
      expect(user.lastName).toBe('Raza');
      expect(user.phone).toBe('+15555559876');
      expect(user.city).toBe('Lahore');
      expect(user.id).toBe(body.data.userId);

      const event = await testPrisma.webhookEvent.findUniqueOrThrow({
        where: { eventId: 'ghl:ghl-contact-abc123' },
      });

      expect(event.status).toBe('PROCESSED');
      expect(event.type).toBe('user.registration');
      expect(event.source).toBe('gohighlevel');
      expect(user.webhookEventId).toBe(event.id);
    });

    it('drops merge fields GoHighLevel left empty', async () => {
      // An unmapped GHL merge field arrives as '', not as an absent key.
      // `tier: ''` is the one that bites: the enum check would reject it and
      // take the whole registration down with it.
      const response = await send(
        contact({ mobileNumber: '', tier: '', city: '', postalCode: '' }),
      ).expect(200);

      expect((response.body as AckBody).data.status).toBe('PROCESSED');

      const user = await testPrisma.user.findUniqueOrThrow({
        where: { email: 'ali.raza@example.com' },
      });

      expect(user.tier).toBe('PLAYER');
      expect(user.phone).toBeNull();
      expect(user.city).toBeNull();
    });
  });

  describe('idempotency', () => {
    it('returns DUPLICATE and creates no second user when GHL retries', async () => {
      const first = await send(contact()).expect(200);
      const firstBody = first.body as AckBody;

      // A GHL workflow retry resends the same contact, so the same contactId
      // arrives again. It must not become a second user.
      const second = await send(contact()).expect(200);
      const secondBody = second.body as AckBody;

      expect(secondBody.data.status).toBe('DUPLICATE');
      expect(secondBody.data.userId).toBe(firstBody.data.userId);

      expect(await testPrisma.user.count()).toBe(1);
      expect(await testPrisma.webhookEvent.count()).toBe(1);
    });

    it('treats a different contact as a new registration', async () => {
      await send(contact()).expect(200);

      // Phone varies too: it carries a unique index, so reusing it would fail
      // the second registration for a reason this test is not about.
      const response = await send(
        contact({
          contactId: 'ghl-contact-xyz789',
          email: 'sana@example.com',
          mobileNumber: '+15555550001',
        }),
      ).expect(200);

      expect((response.body as AckBody).data.status).toBe('PROCESSED');
      expect(await testPrisma.user.count()).toBe(2);
    });
  });

  describe('unusable bodies', () => {
    it('fails a body with no contactId instead of creating a user', async () => {
      const response = await send(contact({ contactId: undefined })).expect(
        200,
      );

      const body = response.body as AckBody;

      expect(body.data.status).toBe('FAILED');
      expect(body.data.reason).toContain('contactId');
      expect(await testPrisma.user.count()).toBe(0);

      // Still stored, so an operator can see what the workflow actually sent.
      expect(await testPrisma.webhookEvent.count()).toBe(1);
    });

    it('fails a duplicate email without a 4xx the workflow would retry', async () => {
      await send(contact()).expect(200);

      const response = await send(
        contact({ contactId: 'ghl-contact-other' }),
      ).expect(200);

      const body = response.body as AckBody;

      expect(body.data.status).toBe('FAILED');
      expect(body.data.reason).toContain('Email');
      expect(await testPrisma.user.count()).toBe(1);
    });

    it('answers malformed JSON with 200 FAILED, never 400', async () => {
      // body-parser throws a SyntaxError that the webhook error handler
      // swallows; a 400 here would put the workflow into a retry loop over a
      // request that can never succeed.
      const response = await request(server())
        .post(ENDPOINT)
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${token()}`)
        .send('{"contactId": "broken"')
        .expect(200);

      expect((response.body as AckBody).data.status).toBe('FAILED');
      expect(await testPrisma.user.count()).toBe(0);
    });
  });

  describe("GoHighLevel's own payload shape", () => {
    it('registers a contact with no custom data mapped at all', async () => {
      // What GHL sends on its own: the action fires "a webhook containing the
      // contact's details" regardless of custom data, in its own snake_case.
      // Reading it means the workflow needs only a URL and an auth header.
      const response = await send({
        contact_id: 'ghl-native-999',
        first_name: 'Ahmed',
        last_name: 'Ahmed',
        full_name: 'Ahmed Ahmed',
        email: 'ahmed.ahmed@example.com',
        phone: '+15555552222',
        city: 'Daytona Beach',
        date_created: '2026-08-25T14:46:15.000Z',
        workflow: { id: 'wf-1', name: 'BJspade 2' },
      }).expect(200);

      expect((response.body as AckBody).data.status).toBe('PROCESSED');

      const user = await testPrisma.user.findUniqueOrThrow({
        where: { email: 'ahmed.ahmed@example.com' },
      });

      expect(user.firstName).toBe('Ahmed');
      expect(user.lastName).toBe('Ahmed');
      expect(user.phone).toBe('+15555552222');
      expect(user.city).toBe('Daytona Beach');
      expect(user.tier).toBe('PLAYER');

      // GHL's extra keys are whitelisted away rather than rejected, but the
      // untouched body is kept for inspection.
      const event = await testPrisma.webhookEvent.findUniqueOrThrow({
        where: { eventId: 'ghl:ghl-native-999' },
      });

      expect(event.status).toBe('PROCESSED');
      expect(
        (event.payload as { raw: { workflow: unknown } }).raw.workflow,
      ).toEqual({ id: 'wf-1', name: 'BJspade 2' });
    });

    it('reads mapped pairs nested under customData', async () => {
      const response = await send({
        contact_id: 'standard-id',
        email: 'standard@example.com',
        customData: {
          contactId: 'nested-id',
          fullName: 'Ali Raza',
          email: 'nested@example.com',
          tier: 'VIP',
        },
      }).expect(200);

      expect((response.body as AckBody).data.status).toBe('PROCESSED');
      expect((response.body as AckBody).data.eventId).toBe('ghl:nested-id');

      // The hand-mapped values win: someone chose them on purpose.
      const user = await testPrisma.user.findUniqueOrThrow({
        where: { email: 'nested@example.com' },
      });

      expect(user.tier).toBe('VIP');
    });
  });
});
