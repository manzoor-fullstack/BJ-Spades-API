import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { applyWebhookRawBodyParser } from '../src/modules/webhooks/webhook-raw-body';

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
}

export async function createTestApp(
  options: TestAppOptions = {},
): Promise<INestApplication> {
  process.env.THROTTLE_DISABLED = options.throttling ? 'false' : 'true';

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();

  // Must come before app.init(), exactly as in main.ts: init() is where Nest
  // installs its own JSON parser, and whichever parser is registered first is
  // the one that sees the unparsed bytes. Omitting this here would make the
  // webhook signature tests fail for a reason production does not share.
  applyWebhookRawBodyParser(app);

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
