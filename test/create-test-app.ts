import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { applyStaticAssets } from '../src/modules/storage/static-assets';
import { applyStripeRawBodyParser } from '../src/modules/stripe/stripe-raw-body';
import { applyWebhookRawBodyParser } from '../src/modules/webhooks/webhook-raw-body';

/**
 * One provider swapped out for the duration of a suite.
 *
 * The Stripe gateway is the motivating case: it is replaced at the SDK boundary
 * so no test can reach api.stripe.com, and so the transfer failure and
 * concurrency paths — the two that matter financially — are reproducible.
 */
export interface TestProviderOverride {
  provide: unknown;
  useValue: unknown;
}

export interface TestAppOptions {
  /**
   * Leave rate limiting active. Off by default.
   *
   * Login is capped at 5 attempts per minute, which is correct in production
   * and fatal in a suite that signs in dozens of times — every test after the
   * fifth would 429 and fail for the wrong reason. Rate limiting is covered
   * deliberately by rate-limit.integration.spec.ts, which opts back in.
   *
   * Driven by THROTTLE_DISABLED rather than by overriding the guard:
   * ThrottlerGuard is bound through APP_GUARD, and overrideGuard() does not
   * reliably intercept it.
   */
  throttling?: boolean;

  /** Providers to replace, e.g. `{ provide: STRIPE_GATEWAY, useValue: fake }`. */
  overrides?: readonly TestProviderOverride[];
}

export async function createTestApp(
  options: TestAppOptions = {},
): Promise<INestApplication> {
  process.env.THROTTLE_DISABLED = options.throttling ? 'false' : 'true';

  let builder = Test.createTestingModule({ imports: [AppModule] });

  for (const override of options.overrides ?? []) {
    builder = builder
      .overrideProvider(override.provide)
      .useValue(override.useValue);
  }

  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();

  // Must come before app.init(), exactly as in main.ts: init() is where Nest
  // installs its own JSON parser, and whichever parser is registered first is
  // the one that sees the unparsed bytes. Omitting this here would make the
  // webhook signature tests fail for a reason production does not share.
  applyWebhookRawBodyParser(app);

  // Same reason, for the Stripe webhook path: the signature is computed over
  // the raw bytes, so the suite must go through the identical middleware.
  applyStripeRawBodyParser(app);

  // Same order as main.ts, so the integration suite fetches uploaded images
  // over the identical /uploads path production serves them on.
  applyStaticAssets(app);

  // Mirrors main.ts so tests exercise the same pipe / filter / interceptor
  // stack a real request goes through.
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  await app.init();

  return app;
}

export const SEEDED_ADMIN = {
  email: 'admin@bjspades.com',
  password: 'Admin123!',
};
