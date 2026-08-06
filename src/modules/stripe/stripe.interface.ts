/**
 * The Stripe surface this application uses, and nothing else.
 *
 * An interface rather than the SDK client itself (ADR-003, the same reasoning
 * as StorageService): the SDK is replaced by a fake in every test, so no test
 * can accidentally reach api.stripe.com, and the payout service is written
 * against four methods instead of against Stripe's whole API.
 */
export const STRIPE_GATEWAY = Symbol('STRIPE_GATEWAY');

export interface CreateTransferParams {
  /** Major units (dollars). Converted to cents at the SDK boundary. */
  amount: string;
  currency: string;
  /** The recipient's Stripe Connect account id (`acct_…`). */
  destination: string;
  /**
   * MUST be `payout_{payoutId}`.
   *
   * This is the layer that survives the dangerous failure: the transfer
   * succeeds at Stripe but the HTTP response is lost, so our status never
   * reaches PAID. On retry Stripe returns the original transfer instead of
   * creating a second one.
   */
  idempotencyKey: string;
  metadata?: Record<string, string>;
}

export interface StripeTransfer {
  id: string;
  amount: number;
  currency: string;
  destination: string | null;
}

export interface CreateConnectAccountParams {
  email: string;
  /** Stored in Stripe metadata so a webhook can be traced back to a user. */
  userId: string;
  country?: string;
}

export interface StripeConnectAccount {
  id: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

export interface CreateAccountLinkParams {
  accountId: string;
  refreshUrl: string;
  returnUrl: string;
}

export interface StripeAccountLink {
  url: string;
  /** Unix seconds. Stripe onboarding links are short-lived. */
  expiresAt: number;
}

/** The slice of a Stripe event the webhook handler reads. */
export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export interface StripeGateway {
  /** False when STRIPE_SECRET_KEY is absent; every other call then throws. */
  isConfigured(): boolean;

  createTransfer(params: CreateTransferParams): Promise<StripeTransfer>;

  createConnectAccount(
    params: CreateConnectAccountParams,
  ): Promise<StripeConnectAccount>;

  retrieveConnectAccount(accountId: string): Promise<StripeConnectAccount>;

  createAccountLink(
    params: CreateAccountLinkParams,
  ): Promise<StripeAccountLink>;

  /**
   * Verifies Stripe's signature over the RAW request bytes and returns the
   * event. Throws on a bad signature — the caller answers 400.
   */
  constructWebhookEvent(payload: Buffer, signature: string): StripeWebhookEvent;
}
