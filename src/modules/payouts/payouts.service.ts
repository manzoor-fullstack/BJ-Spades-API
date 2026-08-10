import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ActivityCategory,
  PayoutStatus,
  StripeAccountStatus,
  TransactionType,
} from '@prisma/client';
import type { User } from '@prisma/client';

import { ACTIVITY_ACTIONS } from '../../common/constants/activity-actions';
import {
  buildPaginationMeta,
  resolveSortField,
  SortOrder,
} from '../../common/dto/pagination.dto';
import type { Paginated } from '../../common/interceptors/transform.interceptor';
import { formatMoney } from '../../common/money/money.util';
import { ActivityLogService } from '../activity/activity.service';
import type { AuthenticatedAdmin } from '../auth/interfaces/authenticated-admin.interface';
import { STRIPE_GATEWAY } from '../stripe/stripe.interface';
import type {
  StripeGateway,
  StripeWebhookEvent,
} from '../stripe/stripe.interface';

import { CancelPayoutDto } from './dto/payout-action.dto';
import { QueryPayoutsDto } from './dto/query-payouts.dto';
import { APPROVABLE_FROM, CANCELLABLE_FROM } from './payout-status';
import { assertPayoutTransition } from './payout-status';
import { PayoutsRepository } from './repositories/payouts.repository';
import type {
  ListPayoutsArgs,
  PayoutFilter,
  PayoutWithRelations,
} from './repositories/payouts.repository';
import { toPayoutListItem } from './serializers/payout.serializer';
import type {
  PayoutListItem,
  PayoutStats,
} from './serializers/payout.serializer';

const SORTABLE_FIELDS = [
  'owedSince',
  'createdAt',
  'updatedAt',
  'amount',
  'status',
  'paidAt',
  'approvedAt',
] as const;

/** Oldest debt first — the page is a work queue, not a changelog. */
const DEFAULT_SORT_FIELD = 'owedSince';

/** The four eligibility messages, verbatim from PHASE-6.md. */
export const PROCESS_ERRORS = {
  NOT_APPROVED: 'Payout must be approved before processing',
  NOT_VERIFIED: 'User has not completed Stripe onboarding',
  ALREADY_PROCESSED: 'Payout has already been processed',
  NOT_POSITIVE: 'Payout amount must be positive',
} as const;

/** Stripe's own idempotency key for a transfer. Never change this format. */
export function transferIdempotencyKey(payoutId: string): string {
  return `payout_${payoutId}`;
}

export interface StripeOnboardingLink {
  userId: string;
  stripeConnectAccountId: string;
  stripeAccountStatus: StripeAccountStatus;
  url: string;
  /** ISO instant; Stripe onboarding links expire within minutes. */
  expiresAt: Date;
}

export interface StripeWebhookResult {
  received: true;
  eventId: string;
  type: string;
  handled: boolean;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseRangeStart(value: string): Date {
  return new Date(DATE_ONLY.test(value) ? `${value}T00:00:00.000Z` : value);
}

function parseRangeEnd(value: string): Date {
  return new Date(DATE_ONLY.test(value) ? `${value}T23:59:59.999Z` : value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads a boolean off a loosely-typed Stripe event payload. */
function flag(object: Record<string, unknown>, key: string): boolean {
  return object[key] === true;
}

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly repository: PayoutsRepository,
    private readonly activity: ActivityLogService,
    private readonly config: ConfigService,
    @Inject(STRIPE_GATEWAY) private readonly stripe: StripeGateway,
  ) {}

  async findAll(query: QueryPayoutsDto): Promise<Paginated<PayoutListItem[]>> {
    const args = this.buildListArgs(query);

    const [payouts, total] = await Promise.all([
      this.repository.findMany(args),
      this.repository.count(args.filter),
    ]);

    return {
      data: payouts.map(toPayoutListItem),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async stats(): Promise<PayoutStats> {
    const row = await this.repository.stats();

    return {
      totalPrizePool: formatMoney(row.totalPrizePool ?? 0),
      paidOut: formatMoney(row.paidOut ?? 0),
      pendingPayouts: formatMoney(row.pendingPayouts ?? 0),
      readyToSend: formatMoney(row.readyToSend ?? 0),
      blocked: formatMoney(row.blocked ?? 0),
      pendingReview: row.pendingReview,
      owedToPlayers: formatMoney(row.owedToPlayers ?? 0),
      playersAwaiting: row.playersAwaiting,
    };
  }

  async findOne(id: string): Promise<PayoutListItem> {
    return toPayoutListItem(await this.getOrThrow(id));
  }

  async approve(
    id: string,
    admin: AuthenticatedAdmin,
  ): Promise<PayoutListItem> {
    const existing = await this.getOrThrow(id);

    assertPayoutTransition(existing.status, PayoutStatus.APPROVED);

    const count = await this.repository.approve(id, admin.id, APPROVABLE_FROM);

    if (count === 0) {
      // Somebody else moved it between the read and the write.
      throw new UnprocessableEntityException(
        'The payout changed while it was being approved. Reload and retry.',
      );
    }

    return toPayoutListItem(await this.getOrThrow(id));
  }

  async cancel(
    id: string,
    dto: CancelPayoutDto,
    _admin: AuthenticatedAdmin,
  ): Promise<PayoutListItem> {
    const existing = await this.getOrThrow(id);

    assertPayoutTransition(existing.status, PayoutStatus.CANCELLED);

    const count = await this.repository.cancel(
      id,
      dto.reason.trim(),
      CANCELLABLE_FROM,
    );

    if (count === 0) {
      throw new UnprocessableEntityException(
        'The payout changed while it was being cancelled. Reload and retry.',
      );
    }

    return toPayoutListItem(await this.getOrThrow(id));
  }

  /**
   * Executes the Stripe Connect transfer.
   *
   * Three independent layers stop a double payment, because a duplicated
   * transfer cannot be undone:
   *
   *  1. **Status guard.** `claimForProcessing` is a conditional
   *     `APPROVED → PROCESSING` update, so of two concurrent requests exactly
   *     one reaches Stripe and the other gets 422. A read-then-write check here
   *     would let both through.
   *  2. **Unique constraint.** `Payout.stripeTransferId` is `@unique`, so a
   *     second attempt to record the same transfer fails at the database.
   *  3. **Idempotency key.** Every transfer sends `payout_{id}`. This is the one
   *     that matters: it covers the transfer succeeding at Stripe while the
   *     response is lost to a timeout, where layers 1 and 2 cannot help because
   *     nothing local ever learned the transfer happened. On retry Stripe
   *     returns the original transfer rather than making a second one.
   */
  async process(
    id: string,
    admin: AuthenticatedAdmin,
  ): Promise<PayoutListItem> {
    const payout = await this.getOrThrow(id);

    this.assertProcessable(payout);

    if (!this.stripe.isConfigured()) {
      // Checked before the claim, so an unconfigured environment never parks a
      // payout in PROCESSING with no transfer behind it.
      throw new ServiceUnavailableException(
        'Stripe is not configured. Set STRIPE_SECRET_KEY (test mode: sk_test_…) ' +
          'and restart the API.',
      );
    }

    const claim = await this.repository.claimForProcessing(id);

    if (claim.outcome === 'NOT_FOUND') {
      throw new NotFoundException(`Payout ${id} not found`);
    }

    if (claim.outcome === 'NOT_CLAIMED') {
      // Lost the race. Re-derive the message from what the row says now, so
      // the loser of two concurrent processes is told the specific reason.
      this.assertProcessable(claim.payout);

      throw new UnprocessableEntityException(PROCESS_ERRORS.NOT_APPROVED);
    }

    const destination = payout.user.stripeConnectAccountId;

    if (!destination) {
      await this.repository.releaseAfterFailure(
        id,
        'No Stripe Connect account on the recipient',
      );

      throw new UnprocessableEntityException(PROCESS_ERRORS.NOT_VERIFIED);
    }

    let transferId: string;

    try {
      const transfer = await this.stripe.createTransfer({
        amount: formatMoney(payout.amount),
        currency: payout.currency,
        destination,
        idempotencyKey: transferIdempotencyKey(id),
        metadata: { payoutId: id, userId: payout.userId },
      });

      transferId = transfer.id;
    } catch (error) {
      const reason = errorMessage(error);

      // The payout goes back exactly where it was. Nothing moved at Stripe and
      // nothing moved in the ledger, so leaving it in PROCESSING would strand
      // it in a state only a database edit could clear.
      await this.repository.releaseAfterFailure(id, reason);

      await this.activity.record({
        category: ActivityCategory.PAYOUT,
        action: ACTIVITY_ACTIONS.PAYOUT_FAILED.code,
        title: `Payout of ${formatMoney(payout.amount)} to ${payout.user.email} failed`,
        description: reason,
        adminId: admin.id,
        entityType: 'Payout',
        entityId: id,
        metadata: { amount: formatMoney(payout.amount), reason },
      });

      this.logger.error(`Stripe transfer for payout ${id} failed: ${reason}`);

      // A 503 from an unconfigured gateway stays a 503; anything else is
      // Stripe declining, which the operator can act on.
      if (error instanceof HttpException) {
        throw error;
      }

      throw new UnprocessableEntityException(
        `Stripe refused the transfer: ${reason}`,
      );
    }

    const result = await this.repository.markPaid({
      payoutId: id,
      stripeTransferId: transferId,
      ledger: {
        userId: payout.userId,
        type: TransactionType.PRIZE,
        amount: payout.amount,
        description: `Prize payout${payout.tournament ? ` for ${payout.tournament.name}` : ''}`,
        // Deterministic and unique: a second ledger row for the same payout is
        // a database error rather than a silent duplicate credit.
        reference: `payout:${id}`,
        tournamentId: payout.tournamentId,
        payoutId: id,
        createdByAdminId: admin.id,
      },
    });

    if (result.outcome !== 'PAID') {
      throw new UnprocessableEntityException(
        'The recipient no longer exists; the transfer was not recorded.',
      );
    }

    await this.activity.record({
      category: ActivityCategory.PAYOUT,
      action: ACTIVITY_ACTIONS.PAYOUT_PROCESSED.code,
      title: `Payout of ${formatMoney(payout.amount)} sent to ${payout.user.email}`,
      adminId: admin.id,
      entityType: 'Payout',
      entityId: id,
      metadata: {
        amount: formatMoney(payout.amount),
        stripeTransferId: transferId,
        transactionId: result.transaction.id,
      },
    });

    return toPayoutListItem(result.payout);
  }

  /**
   * Creates a Stripe Express account if the user has none and returns a hosted
   * onboarding link.
   *
   * The link is handed to the admin to send out of band: Milestone 1 has no
   * player-facing application to redirect into (PHASE-6.md, step 4). Stripe
   * performs the identity verification, which is why no KYC system is built
   * here (docs/05-DEFERRED-SCOPE.md D-13).
   */
  async createOnboardingLink(
    userId: string,
    admin: AuthenticatedAdmin,
  ): Promise<StripeOnboardingLink> {
    const user = await this.repository.findUserById(userId);

    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    if (user.deletedAt) {
      throw new UnprocessableEntityException(
        'Cannot onboard a deleted user to Stripe.',
      );
    }

    if (!this.stripe.isConfigured()) {
      throw new ServiceUnavailableException(
        'Stripe is not configured. Set STRIPE_SECRET_KEY (test mode: sk_test_…) ' +
          'and restart the API.',
      );
    }

    const accountId = await this.ensureConnectAccount(user);

    const link = await this.stripe.createAccountLink({
      accountId,
      refreshUrl: this.onboardingUrl(userId, 'refresh'),
      returnUrl: this.onboardingUrl(userId, 'return'),
    });

    await this.activity.record({
      category: ActivityCategory.PAYOUT,
      action: ACTIVITY_ACTIONS.PAYOUT_STRIPE_ONBOARDING_STARTED.code,
      title: `Stripe onboarding link generated for ${user.email}`,
      adminId: admin.id,
      entityType: 'User',
      entityId: userId,
      // Deliberately not the URL: an onboarding link is a bearer credential
      // for someone else's identity verification.
      metadata: { stripeConnectAccountId: accountId },
    });

    const refreshed = await this.repository.findUserById(userId);

    return {
      userId,
      stripeConnectAccountId: accountId,
      stripeAccountStatus:
        refreshed?.stripeAccountStatus ?? StripeAccountStatus.PENDING,
      url: link.url,
      expiresAt: new Date(link.expiresAt * 1000),
    };
  }

  /**
   * Verifies Stripe's signature over the raw bytes and applies the event.
   *
   * A bad signature is a 400 and nothing else happens — this endpoint is
   * `@Public()`, so the signature is the *only* thing standing between the
   * internet and `User.stripeAccountStatus`.
   */
  async handleWebhook(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<StripeWebhookResult> {
    if (!rawBody || rawBody.length === 0) {
      throw new BadRequestException('Missing request body');
    }

    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }

    let event: StripeWebhookEvent;

    try {
      event = this.stripe.constructWebhookEvent(rawBody, signature);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.logger.warn(
        `Rejected a Stripe webhook with an invalid signature: ${errorMessage(error)}`,
      );

      throw new BadRequestException('Invalid Stripe signature');
    }

    const handled = await this.applyWebhookEvent(event);

    return { received: true, eventId: event.id, type: event.type, handled };
  }

  private async applyWebhookEvent(event: StripeWebhookEvent): Promise<boolean> {
    const object = event.data.object;

    switch (event.type) {
      case 'account.updated': {
        const accountId = typeof object.id === 'string' ? object.id : undefined;

        if (!accountId) {
          return false;
        }

        const status = mapAccountStatus(object);
        const updated = await this.repository.setStripeStatusByAccountId(
          accountId,
          status,
        );

        if (updated > 0) {
          await this.activity.record({
            category: ActivityCategory.PAYOUT,
            action: ACTIVITY_ACTIONS.PAYOUT_STRIPE_ACCOUNT_UPDATED.code,
            title: `Stripe account ${accountId} is now ${status}`,
            entityType: 'User',
            metadata: { stripeConnectAccountId: accountId, status },
          });
        }

        return updated > 0;
      }

      case 'transfer.failed': {
        const transferId =
          typeof object.id === 'string' ? object.id : undefined;

        if (!transferId) {
          return false;
        }

        const payout = await this.repository.findByStripeTransferId(transferId);

        if (!payout) {
          return false;
        }

        await this.repository.markFailed(
          payout.id,
          typeof object.failure_message === 'string'
            ? object.failure_message
            : 'Stripe reported the transfer as failed',
        );

        return true;
      }

      // Confirmations of something already recorded when `process` returned.
      // Acknowledged so Stripe stops retrying; nothing to change.
      case 'transfer.created':
      case 'transfer.paid':
        return false;

      default:
        this.logger.debug(`Ignoring unhandled Stripe event ${event.type}`);
        return false;
    }
  }

  private async ensureConnectAccount(user: User): Promise<string> {
    if (user.stripeConnectAccountId) {
      return user.stripeConnectAccountId;
    }

    const account = await this.stripe.createConnectAccount({
      email: user.email,
      userId: user.id,
    });

    await this.repository.setStripeAccount(
      user.id,
      account.id,
      // PENDING, not VERIFIED: the account exists but nobody has completed the
      // hosted onboarding yet. Only `account.updated` may promote it.
      account.payoutsEnabled
        ? StripeAccountStatus.VERIFIED
        : StripeAccountStatus.PENDING,
    );

    return account.id;
  }

  private onboardingUrl(userId: string, outcome: string): string {
    const base = (
      this.config.get<string>('app.publicUrl') ?? 'http://localhost:5000'
    ).replace(/\/+$/, '');

    return `${base}/api/payouts/stripe/onboard/${userId}/${outcome}`;
  }

  /**
   * The four guards from PHASE-6.md, "Payout eligibility". All 422 with the
   * specific message, because "cannot process" tells an operator nothing.
   */
  private assertProcessable(payout: PayoutWithRelations): void {
    // Checked first, ahead of the status: a PAID payout satisfies both this and
    // the status guard, and "already processed" is the answer that matters.
    if (payout.stripeTransferId || payout.status === PayoutStatus.PAID) {
      throw new UnprocessableEntityException(PROCESS_ERRORS.ALREADY_PROCESSED);
    }

    if (payout.status !== PayoutStatus.APPROVED) {
      throw new UnprocessableEntityException(PROCESS_ERRORS.NOT_APPROVED);
    }

    if (payout.user.stripeAccountStatus !== StripeAccountStatus.VERIFIED) {
      throw new UnprocessableEntityException(PROCESS_ERRORS.NOT_VERIFIED);
    }

    if (!payout.amount.greaterThan(0)) {
      throw new UnprocessableEntityException(PROCESS_ERRORS.NOT_POSITIVE);
    }
  }

  private buildListArgs(query: QueryPayoutsDto): ListPayoutsArgs {
    const filter: PayoutFilter = {
      search: query.search?.trim() ? query.search.trim() : undefined,
      status: query.status,
      method: query.method,
      userId: query.userId,
      tournamentId: query.tournamentId,
      owedFrom: query.owedFrom ? parseRangeStart(query.owedFrom) : undefined,
      owedTo: query.owedTo ? parseRangeEnd(query.owedTo) : undefined,
    };

    return {
      filter,
      sortBy: resolveSortField(
        query.sortBy,
        SORTABLE_FIELDS,
        DEFAULT_SORT_FIELD,
      ),
      sortOrder: query.sortOrder === SortOrder.ASC ? 'asc' : 'desc',
      skip: query.skip,
      take: query.take,
    };
  }

  private async getOrThrow(id: string): Promise<PayoutWithRelations> {
    const payout = await this.repository.findById(id);

    if (!payout) {
      throw new NotFoundException(`Payout ${id} not found`);
    }

    return payout;
  }
}

/**
 * Stripe's account flags mapped onto our four-state enum.
 *
 * `payouts_enabled` is the one that decides VERIFIED: it is Stripe saying it is
 * willing to send this account money, which is the only question a payout asks.
 */
export function mapAccountStatus(
  account: Record<string, unknown>,
): StripeAccountStatus {
  if (flag(account, 'payouts_enabled')) {
    return StripeAccountStatus.VERIFIED;
  }

  const requirements = account.requirements;
  const disabledReason =
    typeof requirements === 'object' &&
    requirements !== null &&
    'disabled_reason' in requirements
      ? (requirements as { disabled_reason?: unknown }).disabled_reason
      : undefined;

  // Details submitted but payouts still off, or Stripe naming a blocker, means
  // the account exists and cannot be paid — which is exactly RESTRICTED.
  if (
    flag(account, 'details_submitted') ||
    typeof disabledReason === 'string'
  ) {
    return StripeAccountStatus.RESTRICTED;
  }

  return StripeAccountStatus.PENDING;
}
