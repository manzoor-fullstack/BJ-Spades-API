import type { IncomingMessage, ServerResponse } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import * as bodyParser from 'body-parser';
import type { NextFunction, Request, Response } from 'express';

import type { RawBodyRequest } from '../webhooks/webhook-raw-body';

/**
 * Full Express path of the Stripe webhook — not the Nest controller path.
 * `app.use()` registers on the Express instance, which knows nothing about
 * `setGlobalPrefix('api')`.
 */
export const STRIPE_WEBHOOK_PATH = '/api/payouts/stripe/webhook';

export const STRIPE_WEBHOOK_BODY_LIMIT = '1mb';

/**
 * Captures the exact bytes Stripe signed.
 *
 * Identical concern to `applyWebhookRawBodyParser`, at a different path
 * (PHASE-6.md, "Stripe webhook"). `stripe.webhooks.constructEvent` computes an
 * HMAC over the raw body; Nest's JSON parser hands the controller a
 * *re-serialised* object whose key order and whitespace come from
 * `JSON.stringify`, so verifying against it fails every single time and looks
 * exactly like a wrong signing secret.
 *
 * Must be registered before `app.init()`, and the wrapper must NOT be named
 * `jsonParser`: Nest decides whether to install its own body parsers by looking
 * for a router layer with that function name, and an unwrapped
 * `bodyParser.json()` would make it skip global JSON parsing for the entire
 * API.
 */
export function applyStripeRawBodyParser(app: INestApplication): void {
  const parser = bodyParser.json({
    limit: STRIPE_WEBHOOK_BODY_LIMIT,
    verify: (req: IncomingMessage, _res: ServerResponse, buf: Buffer) => {
      (req as IncomingMessage & RawBodyRequest).rawBody = buf;
    },
  });

  const stripeJsonParser = (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    parser(req, res, next);
  };

  app.use(STRIPE_WEBHOOK_PATH, stripeJsonParser);

  // Malformed JSON must surface as the 400 the signature check would produce
  // anyway, not as body-parser's own SyntaxError page. The raw bytes are
  // already captured, so the controller can still reject it deliberately.
  app.use(
    STRIPE_WEBHOOK_PATH,
    (
      error: unknown,
      _req: Request,
      _res: Response,
      next: NextFunction,
    ): void => {
      if (error instanceof SyntaxError && 'body' in error) {
        next();
        return;
      }

      next(error);
    },
  );
}
