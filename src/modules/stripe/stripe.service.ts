import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

import { toMoney } from '../../common/money/money.util';

import type {
  CreateAccountLinkParams,
  CreateConnectAccountParams,
  CreateTransferParams,
  StripeAccountLink,
  StripeConnectAccount,
  StripeGateway,
  StripeTransfer,
  StripeWebhookEvent,
} from './stripe.interface';

/**
 * Stripe deals in the smallest currency unit. `19.99` is 1999 cents, and the
 * conversion goes through Decimal rather than `amount * 100` because the float
 * form of that multiplication produces 1998.9999999999998 for values a ledger
 * sees every day.
 */
export function toMinorUnits(amount: string): number {
  return toMoney(amount).times(100).toDecimalPlaces(0).toNumber();
}

/**
 * The real gateway.
 *
 * Deliberately tolerant of a missing key. `.env` carries no STRIPE_SECRET_KEY
 * in Milestone 1, and an SDK client constructed at boot with `undefined` either
 * throws during module initialisation — taking the whole API down because a
 * payout feature is unconfigured — or fails later with a message about an
 * invalid API key that says nothing about what to do. Instead the client is
 * built lazily and its absence is a 503 naming the variable to set.
 */
@Injectable()
export class StripeService implements StripeGateway {
  private readonly logger = new Logger(StripeService.name);

  private client: Stripe | null = null;

  private readonly secretKey: string | undefined;
  private readonly webhookSecret: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.secretKey = this.trimmed(config.get<string>('stripe.secretKey'));
    this.webhookSecret = this.trimmed(
      config.get<string>('stripe.webhookSecret'),
    );

    if (!this.secretKey) {
      this.logger.warn(
        'STRIPE_SECRET_KEY is not set. Payout processing and Connect ' +
          'onboarding will answer 503 until it is; everything else is unaffected.',
      );
    }
  }

  isConfigured(): boolean {
    return Boolean(this.secretKey);
  }

  async createTransfer(params: CreateTransferParams): Promise<StripeTransfer> {
    const transfer = await this.stripe().transfers.create(
      {
        amount: toMinorUnits(params.amount),
        currency: params.currency,
        destination: params.destination,
        ...(params.metadata ? { metadata: params.metadata } : {}),
      },
      // The third double-payment guard. Stripe collapses a retried request
      // carrying the same key into the original transfer and returns it.
      { idempotencyKey: params.idempotencyKey },
    );

    return {
      id: transfer.id,
      amount: transfer.amount,
      currency: transfer.currency,
      destination:
        typeof transfer.destination === 'string'
          ? transfer.destination
          : (transfer.destination?.id ?? null),
    };
  }

  async createConnectAccount(
    params: CreateConnectAccountParams,
  ): Promise<StripeConnectAccount> {
    const account = await this.stripe().accounts.create({
      type: 'express',
      email: params.email,
      ...(params.country ? { country: params.country } : {}),
      // Carried through to every webhook Stripe fires about this account, so
      // `account.updated` can be resolved to a user without a lookup table.
      metadata: { userId: params.userId },
    });

    return this.toAccount(account);
  }

  async retrieveConnectAccount(
    accountId: string,
  ): Promise<StripeConnectAccount> {
    return this.toAccount(await this.stripe().accounts.retrieve(accountId));
  }

  async createAccountLink(
    params: CreateAccountLinkParams,
  ): Promise<StripeAccountLink> {
    const link = await this.stripe().accountLinks.create({
      account: params.accountId,
      refresh_url: params.refreshUrl,
      return_url: params.returnUrl,
      type: 'account_onboarding',
    });

    return { url: link.url, expiresAt: link.expires_at };
  }

  constructWebhookEvent(
    payload: Buffer,
    signature: string,
  ): StripeWebhookEvent {
    if (!this.webhookSecret) {
      throw new ServiceUnavailableException(
        'Stripe webhooks are not configured. Set STRIPE_WEBHOOK_SECRET.',
      );
    }

    const event = this.stripe().webhooks.constructEvent(
      payload,
      signature,
      this.webhookSecret,
    );

    return {
      id: event.id,
      type: event.type,
      data: { object: event.data.object as unknown as Record<string, unknown> },
    };
  }

  /** Built on first use, not at boot — see the class comment. */
  private stripe(): Stripe {
    if (!this.secretKey) {
      throw new ServiceUnavailableException(
        'Stripe is not configured. Set STRIPE_SECRET_KEY (test mode: sk_test_…) ' +
          'and restart the API.',
      );
    }

    this.client ??= new Stripe(this.secretKey, {
      // Retries are Stripe's own, and every transfer carries an idempotency
      // key, so a retried write cannot double-pay.
      maxNetworkRetries: 2,
      timeout: 20_000,
    });

    return this.client;
  }

  private toAccount(account: Stripe.Account): StripeConnectAccount {
    return {
      id: account.id,
      chargesEnabled: account.charges_enabled ?? false,
      payoutsEnabled: account.payouts_enabled ?? false,
      detailsSubmitted: account.details_submitted ?? false,
    };
  }

  private trimmed(value: string | undefined): string | undefined {
    const trimmed = value?.trim();

    return trimmed ? trimmed : undefined;
  }
}
