import { WebhookEventStatus } from '@prisma/client';

import { ActivityLogService } from '../../activity/activity.service';
import type {
  CreateWebhookEventInput,
  WebhookEventWithUser,
  WebhooksRepository,
} from '../repositories/webhooks.repository';
import { SignatureService } from '../services/signature.service';
import { WebhooksService } from '../webhooks.service';

type MockedRepository = { [K in keyof WebhooksRepository]: jest.Mock };

/**
 * GoHighLevel cannot compute an HMAC signature — its workflow webhook action
 * only sends static values and merge fields. These tests cover the bearer-token
 * path built for it, which shares the whole persist/validate/create pipeline
 * with the signed endpoint and differs only in how the caller is authenticated
 * and how the idempotency key is derived.
 */
function storedEvent(input: CreateWebhookEventInput): WebhookEventWithUser {
  return {
    id: 'event-1',
    eventId: input.eventId,
    source: input.source,
    type: input.type,
    payload: input.payload,
    headers: input.headers ?? null,
    status: WebhookEventStatus.RECEIVED,
    errorMessage: null,
    attempts: 1,
    processedAt: null,
    receivedAt: new Date('2026-08-25T12:00:00.000Z'),
    user: null,
  } as unknown as WebhookEventWithUser;
}

function createService(): {
  service: WebhooksService;
  repository: MockedRepository;
  activityLog: { record: jest.Mock };
} {
  const repository = {
    findEventByEventId: jest.fn().mockResolvedValue(null),
    findEventById: jest.fn().mockResolvedValue(null),
    createEvent: jest
      .fn()
      .mockImplementation((input: CreateWebhookEventInput) =>
        Promise.resolve(storedEvent(input)),
      ),
    markEventFailed: jest.fn().mockResolvedValue(undefined),
    incrementAttempts: jest.fn().mockResolvedValue(undefined),
    findUserByEmail: jest.fn().mockResolvedValue(null),
    findUserByPhone: jest.fn().mockResolvedValue(null),
    createUserFromEvent: jest.fn().mockResolvedValue({ id: 'user-1' }),
    findEvents: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
  };

  const activityLog = { record: jest.fn().mockResolvedValue(undefined) };

  // Never consulted on this path: the bearer token is checked by the guard, so
  // the service does no signature work at all.
  const signatureService = {
    verify: jest.fn(() => {
      throw new Error('SignatureService must not be used on the GHL path.');
    }),
  };

  const service = new WebhooksService(
    repository as unknown as WebhooksRepository,
    signatureService as unknown as SignatureService,
    activityLog as unknown as ActivityLogService,
  );

  return { service, repository, activityLog };
}

describe('WebhooksService.handleGhlRegistration', () => {
  it('creates a user from a GoHighLevel contact', async () => {
    const { service, repository } = createService();

    const result = await service.handleGhlRegistration({
      contactId: 'ghl-contact-1',
      fullName: 'Ali Raza',
      email: 'ali.raza@example.com',
      mobileNumber: '+15555551234',
      tier: 'PREMIUM',
    });

    expect(result).toEqual({
      eventId: 'ghl:ghl-contact-1',
      status: 'PROCESSED',
      userId: 'user-1',
    });

    // The flat GHL body is normalised into the canonical envelope, so the
    // stored payload is replayable through the same retry endpoint as a signed
    // delivery.
    const [created] = repository.createEvent.mock.calls[0] as [
      CreateWebhookEventInput,
    ];

    expect(created.source).toBe('gohighlevel');
    expect(created.type).toBe('user.registration');
    expect(created.payload).toEqual({
      event: 'user.registration',
      data: {
        contactId: 'ghl-contact-1',
        fullName: 'Ali Raza',
        email: 'ali.raza@example.com',
        mobileNumber: '+15555551234',
        tier: 'PREMIUM',
      },
      // The untouched body travels alongside the normalised copy, so a shape we
      // did not anticipate is one query away rather than a reproduction request.
      raw: {
        contactId: 'ghl-contact-1',
        fullName: 'Ali Raza',
        email: 'ali.raza@example.com',
        mobileNumber: '+15555551234',
        tier: 'PREMIUM',
      },
    });
  });

  it('returns DUPLICATE when the same contact is sent again', async () => {
    const { service, repository } = createService();

    repository.findEventByEventId.mockResolvedValue({
      id: 'event-1',
      user: { id: 'user-1' },
    });

    const result = await service.handleGhlRegistration({
      contactId: 'ghl-contact-1',
      fullName: 'Ali Raza',
      email: 'ali.raza@example.com',
    });

    expect(result).toEqual({
      eventId: 'ghl:ghl-contact-1',
      status: 'DUPLICATE',
      userId: 'user-1',
    });

    expect(repository.createUserFromEvent).not.toHaveBeenCalled();
  });

  it('fails a body with no contactId instead of creating a user', async () => {
    const { service, repository } = createService();

    // Without a contact id there is no idempotency key, so every workflow retry
    // would create another user. Refusing is the only safe answer.
    const result = await service.handleGhlRegistration({
      fullName: 'Ali Raza',
      email: 'ali.raza@example.com',
    });

    expect(result.status).toBe('FAILED');
    expect(result.reason).toContain('contactId');
    expect(repository.createUserFromEvent).not.toHaveBeenCalled();
  });

  it('ignores merge fields GoHighLevel left empty', async () => {
    const { service } = createService();

    // An unmapped GHL merge field arrives as an empty string, not as an absent
    // key. `tier: ''` is the one that bites: @IsOptional() only skips null and
    // undefined, so the enum check would reject the whole registration.
    const result = await service.handleGhlRegistration({
      contactId: 'ghl-contact-2',
      fullName: 'Ali Raza',
      email: 'ali.raza@example.com',
      mobileNumber: '',
      tier: '',
      city: '',
    });

    expect(result.status).toBe('PROCESSED');
  });

  /**
   * GHL's webhook action fires "a webhook containing the contact's details"
   * whether or not custom data is mapped, and it names those details in its own
   * snake_case. Reading them means the workflow needs nothing configured beyond
   * the URL and the Authorization header — seven places to get wrong become two.
   */
  describe("GoHighLevel's own field names", () => {
    it('registers a contact with no custom data mapped at all', async () => {
      const { service } = createService();

      const result = await service.handleGhlRegistration({
        contact_id: 'ghl-native-1',
        full_name: 'Ali Raza',
        email: 'ali.raza@example.com',
        phone: '+15555551234',
      });

      expect(result).toEqual({
        eventId: 'ghl:ghl-native-1',
        status: 'PROCESSED',
        userId: 'user-1',
      });
    });

    it('builds a name from first_name and last_name when full_name is absent', async () => {
      const { service, repository } = createService();

      await service.handleGhlRegistration({
        contact_id: 'ghl-native-2',
        first_name: 'Ali',
        last_name: 'Raza',
        email: 'ali.raza@example.com',
      });

      const [created] = repository.createUserFromEvent.mock.calls[0] as [
        { firstName: string; lastName: string },
      ];

      expect(created.firstName).toBe('Ali');
      expect(created.lastName).toBe('Raza');
    });

    it('prefers explicitly mapped custom data over the standard field', async () => {
      const { service } = createService();

      // Both shapes present: the operator mapped `contactId` by hand, so that
      // is the deliberate choice and must win over GHL's own value.
      const result = await service.handleGhlRegistration({
        contact_id: 'standard-id',
        contactId: 'mapped-id',
        full_name: 'Standard Name',
        fullName: 'Mapped Name',
        email: 'ali.raza@example.com',
      });

      expect(result.eventId).toBe('ghl:mapped-id');
    });

    it('reads custom data nested under customData', async () => {
      const { service } = createService();

      // Some GHL versions nest the mapped pairs instead of merging them into
      // the top level. Reading both shapes means we never had to guess which.
      const result = await service.handleGhlRegistration({
        contact_id: 'standard-id',
        customData: {
          contactId: 'nested-id',
          fullName: 'Ali Raza',
          email: 'ali.raza@example.com',
        },
      });

      expect(result.eventId).toBe('ghl:nested-id');
      expect(result.status).toBe('PROCESSED');
    });

    it('keeps the untouched body so an unrecognised shape can be inspected', async () => {
      const { service, repository } = createService();

      const body = { something: 'entirely unexpected' };

      const result = await service.handleGhlRegistration(body);

      expect(result.status).toBe('FAILED');

      const [created] = repository.createEvent.mock.calls[0] as [
        { payload: { raw?: unknown } },
      ];

      // Without this, diagnosing a shape we did not anticipate means asking the
      // client to reproduce it. With it, the answer is one query away.
      expect(created.payload.raw).toEqual(body);
    });
  });
});
