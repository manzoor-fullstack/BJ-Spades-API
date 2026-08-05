import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ActivityCategory,
  Prisma,
  UserTier,
  WebhookEventStatus,
} from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';

import { ACTIVITY_ACTIONS } from '../../common/constants/activity-actions';
import {
  buildPaginationMeta,
  type PaginationMeta,
} from '../../common/dto/pagination.dto';
import { splitFullName } from '../../common/text/split-full-name.util';
import { ActivityLogService } from '../activity/activity.service';

import type { WebhookAckDto } from './dto/webhook-ack.dto';
import type { WebhookEventsQueryDto } from './dto/webhook-events-query.dto';
import { UserRegistrationWebhookDto } from './dto/user-registration.dto';
import { InvalidSignatureException } from './exceptions/invalid-signature.exception';
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  SOURCE_HEADER,
  SignatureService,
  TIMESTAMP_HEADER,
} from './services/signature.service';
import {
  WebhooksRepository,
  type WebhookEventWithUser,
} from './repositories/webhooks.repository';

export type InboundHeaders = Record<string, string | string[] | undefined>;

export interface InboundWebhook {
  /** Captured by the raw-body middleware before anything parsed it. */
  rawBody: Buffer | undefined;
  headers: InboundHeaders;
}

export interface WebhookEventsPage {
  data: WebhookEventWithUser[];
  meta: PaginationMeta;
}

/**
 * Headers worth keeping on the stored event.
 *
 * An allowlist, not a blocklist: the whole header bag would drag cookies and
 * Authorization values into a table admins can read through the API.
 */
const CAPTURED_HEADERS = [
  'content-type',
  'user-agent',
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  EVENT_ID_HEADER,
  SOURCE_HEADER,
] as const;

const UNKNOWN_SOURCE = 'unknown';
const UNKNOWN_TYPE = 'unknown';

function headerValue(
  headers: InboundHeaders,
  name: string,
): string | undefined {
  const value = headers[name];

  if (Array.isArray(value)) return value[0];

  return value;
}

/** Duck-typed for the same reason AllExceptionsFilter is: the Prisma client is generated. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly repository: WebhooksRepository,
    private readonly signatureService: SignatureService,
    private readonly activityLog: ActivityLogService,
  ) {}

  /**
   * The processing sequence from docs/specs/WEBHOOK-CONTRACT.md.
   *
   * Order is load-bearing:
   *   raw body -> timestamp -> signature -> duplicate -> PERSIST -> validate
   *
   * Persisting before validating is deliberate. An unparseable or malformed
   * payload is exactly the one an operator needs to look at, and dropping it on
   * the floor because it failed a DTO check makes the failure unreproducible.
   */
  async handleUserRegistration(input: InboundWebhook): Promise<WebhookAckDto> {
    const { headers, rawBody } = input;

    const verification = this.signatureService.verify({
      rawBody,
      signature: headerValue(headers, SIGNATURE_HEADER),
      timestamp: headerValue(headers, TIMESTAMP_HEADER),
    });

    if (!verification.valid) {
      // Logged, never returned: the client gets one generic message.
      this.logger.warn(
        `Rejected user-registration webhook: ${verification.reason}`,
      );

      throw new InvalidSignatureException();
    }

    // Narrowing only — `verify` already refused an absent body.
    const body = rawBody ?? Buffer.alloc(0);

    const source =
      headerValue(headers, SOURCE_HEADER)?.trim() || UNKNOWN_SOURCE;

    const suppliedEventId = headerValue(headers, EVENT_ID_HEADER)?.trim();

    // Without an event id there is no idempotency key, so a retry would create
    // a second user. The event is still stored under a synthetic id — a valid
    // signature always earns a 200 and an inspectable record — but it is
    // reported as FAILED so the sender learns what it left out.
    const eventId = suppliedEventId ?? `missing-event-id:${randomUUID()}`;

    const parsed = this.parsePayload(body);

    if (suppliedEventId) {
      const existing = await this.repository.findEventByEventId(eventId);

      if (existing) {
        this.logger.log(`Duplicate webhook event ${eventId}; ignoring.`);

        return {
          eventId,
          status: 'DUPLICATE',
          userId: existing.user?.id,
        };
      }
    }

    let event: WebhookEventWithUser;

    try {
      event = await this.repository.createEvent({
        eventId,
        source,
        type: parsed.type,
        payload: parsed.payload,
        headers: this.captureHeaders(headers),
      });
    } catch (error) {
      // Two identical requests racing each other: the unique index on eventId
      // is what makes idempotency a database guarantee rather than a
      // check-then-act with a window between the two.
      if (isUniqueViolation(error)) {
        const existing = await this.repository.findEventByEventId(eventId);

        return { eventId, status: 'DUPLICATE', userId: existing?.user?.id };
      }

      throw error;
    }

    if (!suppliedEventId) {
      return this.fail(event.id, eventId, `Missing ${EVENT_ID_HEADER} header`);
    }

    if (!parsed.ok) {
      return this.fail(event.id, eventId, parsed.reason);
    }

    // `event.payload` rather than the in-memory copy: what gets replayed by
    // the retry endpoint is what the database actually holds, so a round-trip
    // problem shows up on the first delivery instead of days later.
    return this.processStoredEvent(event.id, eventId, source, event.payload);
  }

  /**
   * Replays a stored payload.
   *
   * Used after the cause of a failure has been fixed — a duplicate email freed
   * up, say. `attempts` is incremented first so an attempt that crashes is
   * still counted.
   */
  async retryEvent(id: string): Promise<WebhookAckDto> {
    const event = await this.repository.findEventById(id);

    if (!event) {
      throw new NotFoundException('Webhook event not found.');
    }

    // A 409 rather than a silent no-op: replaying a processed event is an
    // operator mistake, and the unique webhookEventId would reject it anyway.
    if (event.status === WebhookEventStatus.PROCESSED) {
      throw new ConflictException(
        'This webhook event has already been processed.',
      );
    }

    await this.repository.incrementAttempts(id);

    return this.processStoredEvent(
      event.id,
      event.eventId,
      event.source,
      event.payload,
    );
  }

  async findEvents(query: WebhookEventsQueryDto): Promise<WebhookEventsPage> {
    const { rows, total } = await this.repository.findEvents({
      skip: query.skip,
      take: query.take,
      status: query.status,
      search: query.search,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    });

    return {
      data: rows,
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  /**
   * Validate -> check the email is free -> create the user in a transaction.
   *
   * Shared by the live endpoint and the retry endpoint so a replay follows the
   * exact same rules as the original delivery.
   */
  private async processStoredEvent(
    id: string,
    eventId: string,
    source: string,
    payload: Prisma.JsonValue,
  ): Promise<WebhookAckDto> {
    const validation = await this.validatePayload(payload);

    if (!validation.ok) {
      return this.fail(id, eventId, validation.reason);
    }

    const { data } = validation.dto;

    const existingByEmail = await this.repository.findUserByEmail(data.email);

    if (existingByEmail) {
      return this.fail(id, eventId, 'Email already registered');
    }

    const phone = data.mobileNumber?.trim() || undefined;

    if (phone) {
      const existingByPhone = await this.repository.findUserByPhone(phone);

      if (existingByPhone) {
        return this.fail(id, eventId, 'Mobile number already registered');
      }
    }

    const { firstName, lastName } = splitFullName(data.fullName);

    try {
      const user = await this.repository.createUserFromEvent({
        webhookEventId: id,
        firstName,
        lastName,
        email: data.email,
        phone,
        tier: data.tier ?? UserTier.PLAYER,
        addressLine1: data.addressLine1,
        addressLine2: data.addressLine2,
        city: data.city,
        state: data.state,
        postalCode: data.postalCode,
        country: data.country,

        // Written inside the same transaction as the user, so a webhook user
        // can never exist without its audit entry.
        activity: {
          category: ActivityCategory.WEBHOOK,
          action: ACTIVITY_ACTIONS.WEBHOOK_USER_CREATED.code,
          title: `New user ${data.fullName} registered`,
          description: `Created via webhook from ${source}`,
          entityType: 'User',
          isHighPriority: ACTIVITY_ACTIONS.WEBHOOK_USER_CREATED.isHighPriority,
        },
      });

      this.logger.log(`Webhook ${eventId} created user ${user.id}.`);

      return { eventId, status: 'PROCESSED', userId: user.id };
    } catch (error) {
      // The email/phone checks above are check-then-act; the unique indexes
      // close the race. Anything else is a genuine fault and must surface as a
      // 5xx so the sender retries.
      if (isUniqueViolation(error)) {
        return this.fail(
          id,
          eventId,
          'Email or mobile number already registered',
        );
      }

      await this.repository.markEventFailed(id, 'Unexpected processing error');

      throw error;
    }
  }

  private async fail(
    id: string,
    eventId: string,
    reason: string,
  ): Promise<WebhookAckDto> {
    await this.repository.markEventFailed(id, reason);

    this.logger.warn(`Webhook ${eventId} stored as FAILED: ${reason}`);

    // High priority: a failing registration feed means real signups are being
    // dropped, and nobody watches the application log.
    await this.activityLog.record({
      category: ActivityCategory.WEBHOOK,
      action: ACTIVITY_ACTIONS.WEBHOOK_FAILED.code,
      title: `Webhook ${eventId} failed`,
      description: reason,
      entityType: 'WebhookEvent',
      entityId: id,
    });

    return { eventId, status: 'FAILED', reason };
  }

  /**
   * Re-parses the signed bytes rather than trusting the framework's parsed
   * object, so what lands in `WebhookEvent.payload` is what was actually
   * signed.
   */
  private parsePayload(body: Buffer):
    | { ok: true; payload: Prisma.InputJsonValue; type: string }
    | {
        ok: false;
        payload: Prisma.InputJsonValue;
        type: string;
        reason: string;
      } {
    const text = body.toString('utf8');

    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch {
      // Kept as a string so the exact bytes stay inspectable in the dashboard.
      return {
        ok: false,
        payload: { raw: text },
        type: UNKNOWN_TYPE,
        reason: 'Body is not valid JSON',
      };
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {
        ok: false,
        payload: { raw: text },
        type: UNKNOWN_TYPE,
        reason: 'Payload must be a JSON object',
      };
    }

    const envelope = parsed as Record<string, unknown>;
    const type =
      typeof envelope.event === 'string' && envelope.event.length > 0
        ? envelope.event
        : UNKNOWN_TYPE;

    return {
      ok: true,
      payload: parsed as Prisma.InputJsonValue,
      type,
    };
  }

  private async validatePayload(
    payload: Prisma.JsonValue,
  ): Promise<
    | { ok: true; dto: UserRegistrationWebhookDto }
    | { ok: false; reason: string }
  > {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload)
    ) {
      return { ok: false, reason: 'Payload must be a JSON object' };
    }

    const dto = plainToInstance(UserRegistrationWebhookDto, payload);

    const errors = await validate(dto, {
      // Unknown fields are dropped, not rejected: the contract lets a sender
      // add fields ahead of the API supporting them, and the raw body is kept
      // on the event regardless.
      whitelist: true,
      forbidNonWhitelisted: false,
    });

    if (errors.length > 0) {
      const reason = errors
        .flatMap((error) => this.flattenConstraints(error.constraints, error))
        .join('; ');

      return {
        ok: false,
        reason: reason || 'Payload failed validation',
      };
    }

    return { ok: true, dto };
  }

  private flattenConstraints(
    constraints: Record<string, string> | undefined,
    error: Pick<ValidationError, 'children'>,
  ): string[] {
    const own = constraints ? Object.values(constraints) : [];

    const nested = (error.children ?? []).flatMap((child) =>
      this.flattenConstraints(child.constraints, child),
    );

    return [...own, ...nested];
  }

  private captureHeaders(headers: InboundHeaders): Prisma.InputJsonValue {
    const captured: Record<string, string> = {};

    for (const name of CAPTURED_HEADERS) {
      const value = headerValue(headers, name);

      if (value !== undefined) {
        captured[name] = value;
      }
    }

    return captured;
  }
}
