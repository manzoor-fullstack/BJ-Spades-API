import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Deposit } from '@prisma/client';

import { formatMoney, toMoney } from '../../common/money/money.util';
import { STRIPE_GATEWAY } from '../stripe/stripe.interface';
import type {
  StripeGateway,
  StripeWebhookEvent,
} from '../stripe/stripe.interface';
import { CreateDepositDto } from './dto/create-deposit.dto';
import { PlayerDepositsRepository } from './repositories/player-deposits.repository';
import {
  toPlayerDeposit,
  toPlayerPaymentMethod,
} from './player-deposits.serializer';

const MINIMUM_DEPOSIT = toMoney('10.00');
const MAXIMUM_DEPOSIT = toMoney('10000.00');

function stringValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

function metadataValue(
  object: Record<string, unknown>,
  key: string,
): string | null {
  const metadata = object.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function majorUnits(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    return null;
  return toMoney(value).dividedBy(100).toFixed(2);
}

@Injectable()
export class PlayerDepositsService {
  private readonly logger = new Logger(PlayerDepositsService.name);

  constructor(
    private readonly repository: PlayerDepositsRepository,
    private readonly config: ConfigService,
    @Inject(STRIPE_GATEWAY) private readonly stripe: StripeGateway,
  ) {}

  async create(userId: string, input: CreateDepositDto) {
    const amount = toMoney(input.amount);
    if (
      amount.lessThan(MINIMUM_DEPOSIT) ||
      amount.greaterThan(MAXIMUM_DEPOSIT)
    ) {
      throw new UnprocessableEntityException(
        'Deposit must be between 10.00 and 10000.00 tokens.',
      );
    }

    const user = await this.repository.findUser(userId);
    if (!user) throw new NotFoundException('Player not found.');
    const deposit = await this.repository.createOrFind(
      userId,
      input.requestId,
      amount.toFixed(2),
    );
    if (!deposit.amount.equals(amount)) {
      throw new UnprocessableEntityException(
        'This requestId was already used for a different amount.',
      );
    }
    if (deposit.stripeCheckoutSessionId && deposit.stripeCheckoutUrl) {
      return toPlayerDeposit(deposit);
    }

    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await this.stripe.createCustomer({
        email: user.email,
        userId,
        idempotencyKey: `player-customer_${userId}`,
      });
      customerId = await this.repository.setStripeCustomer(userId, customer.id);
    }

    const appUrl = this.config.get<string>('playerAuth.appUrl');
    if (!appUrl) throw new Error('PLAYER_APP_URL is not configured.');
    const success = new URL(appUrl);
    success.searchParams.set('deposit', deposit.id);
    success.searchParams.set('deposit_return', 'success');
    success.searchParams.set('session_id', '{CHECKOUT_SESSION_ID}');
    const cancel = new URL(appUrl);
    cancel.searchParams.set('deposit', deposit.id);
    cancel.searchParams.set('deposit_return', 'cancel');

    const checkout = await this.stripe.createCheckoutSession({
      amount: formatMoney(deposit.amount),
      currency: deposit.currency,
      customerId,
      depositId: deposit.id,
      successUrl: success.toString(),
      cancelUrl: cancel.toString(),
      idempotencyKey: `deposit_${deposit.id}`,
    });
    return toPlayerDeposit(
      await this.repository.attachCheckout(deposit.id, checkout),
    );
  }

  async list(userId: string) {
    return (await this.repository.listOwned(userId)).map(toPlayerDeposit);
  }

  async findOne(userId: string, id: string) {
    const deposit = await this.repository.findOwned(userId, id);
    if (!deposit) throw new NotFoundException('Deposit not found.');
    return toPlayerDeposit(deposit);
  }

  async paymentMethods(userId: string) {
    return (await this.repository.listPaymentMethods(userId)).map(
      toPlayerPaymentMethod,
    );
  }

  async cancel(userId: string, id: string) {
    const deposit = await this.repository.findOwned(userId, id);
    if (!deposit) throw new NotFoundException('Deposit not found.');
    if (deposit.creditedAt) return toPlayerDeposit(deposit);
    if (deposit.stripeCheckoutSessionId) {
      await this.stripe.expireCheckoutSession(deposit.stripeCheckoutSessionId);
    }
    await this.repository.markCanceled(id);
    return this.findOne(userId, id);
  }

  async handleStripeEvent(event: StripeWebhookEvent): Promise<boolean> {
    const object = event.data.object;
    const sessionId = event.type.startsWith('checkout.session.')
      ? stringValue(object.id)
      : null;
    const paymentIntentId =
      stringValue(object.payment_intent) ??
      (event.type.startsWith('payment_intent.')
        ? stringValue(object.id)
        : null);
    const metadataId = metadataValue(object, 'depositId');
    const deposit = metadataId
      ? await this.repository.findById(metadataId)
      : await this.repository.findByProviderIds(
          sessionId ?? undefined,
          paymentIntentId ?? undefined,
        );
    if (!deposit) return false;

    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
      case 'payment_intent.succeeded':
        return this.settleFromEvent(deposit, event, paymentIntentId);

      case 'checkout.session.async_payment_failed':
      case 'payment_intent.payment_failed': {
        const error = object.last_payment_error;
        const errorObject =
          error && typeof error === 'object'
            ? (error as Record<string, unknown>)
            : {};
        await this.repository.markFailed(
          deposit.id,
          typeof errorObject.code === 'string' ? errorObject.code : null,
          typeof errorObject.message === 'string'
            ? errorObject.message
            : 'Stripe reported that the deposit failed.',
        );
        return true;
      }

      case 'checkout.session.expired':
        await this.repository.markCanceled(deposit.id);
        return true;

      case 'charge.refunded': {
        const refunded = majorUnits(object.amount_refunded);
        if (!refunded) return false;
        return (
          await this.repository.reverse(
            deposit.id,
            'refund',
            refunded,
            event.id,
          )
        ).changed;
      }

      case 'charge.dispute.created':
      case 'charge.dispute.funds_withdrawn': {
        const disputed = majorUnits(object.amount);
        if (!disputed) return false;
        return (
          await this.repository.reverse(
            deposit.id,
            'dispute',
            disputed,
            event.id,
          )
        ).changed;
      }

      case 'charge.dispute.closed':
      case 'charge.dispute.funds_reinstated':
        if (
          object.status === 'won' ||
          event.type === 'charge.dispute.funds_reinstated'
        ) {
          return (await this.repository.restoreDispute(deposit.id, event.id))
            .changed;
        }
        return true;

      default:
        return false;
    }
  }

  private async settleFromEvent(
    deposit: Deposit,
    event: StripeWebhookEvent,
    paymentIntentId: string | null,
  ): Promise<boolean> {
    const object = event.data.object;
    const amount = majorUnits(object.amount_total ?? object.amount_received);
    const currency =
      typeof object.currency === 'string'
        ? object.currency.toUpperCase()
        : null;
    if (!amount || !currency) {
      throw new UnprocessableEntityException(
        'Stripe settlement is missing its amount or currency.',
      );
    }
    if (!deposit.amount.equals(toMoney(amount))) {
      throw new UnprocessableEntityException(
        'Stripe deposit amount does not match the requested amount.',
      );
    }
    if (currency !== deposit.currency) {
      throw new UnprocessableEntityException(
        'Stripe deposit currency does not match the requested currency.',
      );
    }
    if (
      event.type === 'checkout.session.completed' &&
      object.payment_status !== 'paid'
    ) {
      await this.repository.markProcessing(deposit.id, paymentIntentId);
      return true;
    }

    const settled = await this.repository.settle(
      deposit.id,
      paymentIntentId,
      null,
    );
    const resolvedIntent = paymentIntentId ?? deposit.stripePaymentIntentId;
    if (resolvedIntent) {
      try {
        const method =
          await this.stripe.retrievePaymentMethodForIntent(resolvedIntent);
        if (method)
          await this.repository.savePaymentMethod(deposit.userId, method);
      } catch (error) {
        this.logger.warn(
          `Deposit ${deposit.id} settled but payment method metadata could not be refreshed: ${String(error)}`,
        );
      }
    }
    return settled.changed;
  }
}
