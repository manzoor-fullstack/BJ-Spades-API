import { Injectable } from '@nestjs/common';
import {
  ActivityCategory,
  Prisma,
  UserSource,
  UserStatus,
  UserTier,
  WebhookEventStatus,
} from '@prisma/client';

import { SortOrder } from '../../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';

export interface CreateWebhookEventInput {
  eventId: string;
  source: string;
  type: string;
  payload: Prisma.InputJsonValue;
  headers: Prisma.InputJsonValue;
}

/**
 * The audit entry written alongside the user, composed by WebhooksService.
 * `entityId` is filled in here because the user id does not exist until the
 * transaction has already started.
 */
export interface WebhookActivityEntry {
  category: ActivityCategory;
  action: string;
  title: string;
  description: string;
  entityType: string;
  isHighPriority: boolean;
}

export interface CreateUserFromEventInput {
  webhookEventId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  tier: UserTier;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  activity: WebhookActivityEntry;
}

export interface FindEventsInput {
  skip: number;
  take: number;
  status?: WebhookEventStatus;
  search?: string;
  sortBy: string;
  sortOrder: SortOrder;
}

/** The event plus just enough of the linked user to answer a DUPLICATE. */
const EVENT_WITH_USER = {
  user: { select: { id: true } },
} satisfies Prisma.WebhookEventInclude;

export type WebhookEventWithUser = Prisma.WebhookEventGetPayload<{
  include: typeof EVENT_WITH_USER;
}>;

@Injectable()
export class WebhooksRepository {
  constructor(private readonly prisma: PrismaService) {}

  findEventByEventId(eventId: string): Promise<WebhookEventWithUser | null> {
    return this.prisma.webhookEvent.findUnique({
      where: { eventId },
      include: EVENT_WITH_USER,
    });
  }

  findEventById(id: string): Promise<WebhookEventWithUser | null> {
    return this.prisma.webhookEvent.findUnique({
      where: { id },
      include: EVENT_WITH_USER,
    });
  }

  createEvent(input: CreateWebhookEventInput): Promise<WebhookEventWithUser> {
    return this.prisma.webhookEvent.create({
      data: {
        eventId: input.eventId,
        source: input.source,
        type: input.type,
        payload: input.payload,
        headers: input.headers,
        status: WebhookEventStatus.RECEIVED,
      },
      include: EVENT_WITH_USER,
    });
  }

  async markEventFailed(id: string, errorMessage: string): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { id },
      data: {
        status: WebhookEventStatus.FAILED,
        errorMessage,
        // Stamped even on failure so an operator can see when the last attempt
        // ran, not just that one happened.
        processedAt: new Date(),
      },
    });
  }

  async incrementAttempts(id: string): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { id },
      data: { attempts: { increment: 1 } },
    });
  }

  findUserByEmail(email: string): Promise<{ id: string } | null> {
    return this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
  }

  findUserByPhone(phone: string): Promise<{ id: string } | null> {
    return this.prisma.user.findUnique({
      where: { phone },
      select: { id: true },
    });
  }

  /**
   * Creates the user and closes out its event in one transaction.
   *
   * Both halves or neither: an event marked PROCESSED with no user behind it
   * would be invisible to every reconciliation query, and a user with an event
   * still sitting at RECEIVED would be replayed into a duplicate by a retry.
   *
   * The audit entry is written inside the same transaction, not fire-and-forget
   * like the interceptor's: a user created by an anonymous internet form must
   * never exist without the record of where it came from. Carried forward from
   * docs/phases/PHASE-1.md.
   */
  createUserFromEvent(
    input: CreateUserFromEventInput,
  ): Promise<{ id: string }> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          phone: input.phone,
          tier: input.tier,
          addressLine1: input.addressLine1,
          addressLine2: input.addressLine2,
          city: input.city,
          state: input.state,
          postalCode: input.postalCode,
          country: input.country,

          // ACTIVE on arrival, at the client's request (2026-08-26). This was
          // PENDING so an admin had to activate each registration by hand; the
          // client wants signups usable immediately.
          //
          // Nothing in the API gates on PENDING — it is a dashboard label, not
          // a capability check — so the change costs no enforcement. What it
          // costs is the signal: a spam registration now looks like any other
          // active user instead of sitting in a queue. `source: WEBHOOK` is
          // still the way to tell them apart.
          //
          // Written explicitly rather than left to the schema default, which is
          // also ACTIVE: the two agreeing today is a coincidence, and a silent
          // dependency on it would make a future default change move webhook
          // registrations without anyone deciding to.
          source: UserSource.WEBHOOK,
          status: UserStatus.ACTIVE,

          webhookEvent: { connect: { id: input.webhookEventId } },
        },
        select: { id: true },
      });

      await tx.webhookEvent.update({
        where: { id: input.webhookEventId },
        data: {
          status: WebhookEventStatus.PROCESSED,
          processedAt: new Date(),
          // Cleared so a successful retry does not leave the previous failure
          // reason sitting on a PROCESSED row.
          errorMessage: null,
        },
      });

      await tx.activityLog.create({
        data: {
          category: input.activity.category,
          action: input.activity.action,
          title: input.activity.title,
          description: input.activity.description,
          entityType: input.activity.entityType,
          entityId: user.id,
          isHighPriority: input.activity.isHighPriority,
          // No admin: the actor is the external signup form.
          adminId: null,
          metadata: { webhookEventId: input.webhookEventId },
        },
      });

      return user;
    });
  }

  async findEvents(
    input: FindEventsInput,
  ): Promise<{ rows: WebhookEventWithUser[]; total: number }> {
    const where: Prisma.WebhookEventWhereInput = {
      ...(input.status ? { status: input.status } : {}),
      ...(input.search
        ? {
            OR: [
              { eventId: { contains: input.search, mode: 'insensitive' } },
              { source: { contains: input.search, mode: 'insensitive' } },
              { type: { contains: input.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    // `sortBy` is allowlisted by WebhookEventsQueryDto before it reaches here,
    // so the computed key cannot smuggle in an arbitrary column.
    const orderBy = {
      [input.sortBy]: input.sortOrder,
    } as Prisma.WebhookEventOrderByWithRelationInput;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.webhookEvent.findMany({
        where,
        include: EVENT_WITH_USER,
        orderBy,
        skip: input.skip,
        take: input.take,
      }),
      this.prisma.webhookEvent.count({ where }),
    ]);

    return { rows, total };
  }
}
