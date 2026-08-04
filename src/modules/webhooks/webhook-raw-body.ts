import type { IncomingMessage, ServerResponse } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import * as bodyParser from 'body-parser';
import type { NextFunction, Request, Response } from 'express';

/**
 * Express mount path for the webhook routes.
 *
 * This is the *full* URL path, not the Nest controller path: `app.use()`
 * registers on the underlying Express instance, which knows nothing about
 * `setGlobalPrefix('api')`.
 */
export const WEBHOOK_PATH_PREFIX = '/api/webhooks';

/** Bodies larger than this are rejected before any HMAC work is done. */
export const WEBHOOK_BODY_LIMIT = '256kb';

/** Shape added to the request object by the raw-body parser below. */
export interface RawBodyRequest {
  rawBody?: Buffer;
}

/**
 * Captures the exact bytes of a webhook request body before anything parses it.
 *
 * THIS IS THE STEP THAT BREAKS WEBHOOK INTEGRATIONS. Nest installs its own JSON
 * body parser during `app.init()`, so by the time a controller runs,
 * `request.body` is a *re-serialised object* — key order and whitespace are
 * whatever `JSON.stringify` decides, not what the sender signed. Verifying an
 * HMAC against it fails 100% of the time and the symptom (a persistent 401
 * against a correct sender) looks exactly like a wrong shared secret.
 *
 * Two rules make this work:
 *
 *  1. It must be registered BEFORE `app.init()` / `app.listen()`, because that
 *     is when Nest registers its own parser. Express runs middleware in
 *     registration order, so ours has to be first.
 *  2. It is mounted on `/api/webhooks` only. Every other route keeps Nest's
 *     default body handling and pays nothing for a buffer it will never read.
 *
 * Nest's parser still runs afterwards, but body-parser short-circuits on an
 * already-consumed request (`onFinished.isFinished`), so `req.body` set here
 * survives untouched.
 *
 * Called from both `main.ts` and `test/create-test-app.ts` so the integration
 * suite exercises the identical middleware stack — deleting this function
 * breaks the reordered-key regression test immediately.
 */
export function applyWebhookRawBodyParser(app: INestApplication): void {
  const parser = bodyParser.json({
    limit: WEBHOOK_BODY_LIMIT,
    verify: (req: IncomingMessage, _res: ServerResponse, buf: Buffer) => {
      (req as IncomingMessage & RawBodyRequest).rawBody = buf;
    },
  });

  // Wrapped, and the wrapper deliberately does NOT keep the name `jsonParser`.
  //
  // Nest's ExpressAdapter decides whether to install its own body parsers by
  // scanning the router stack for a layer whose handler is *named*
  // `jsonParser` — which is exactly what `bodyParser.json()` returns. Register
  // it unwrapped and Nest concludes JSON parsing is already handled and skips
  // its global parser, leaving every other route in the API with an empty
  // `request.body`. The wrapper keeps this parser scoped to /api/webhooks and
  // invisible to that check.
  const webhookJsonParser = (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    parser(req, res, next);
  };

  app.use(WEBHOOK_PATH_PREFIX, webhookJsonParser);

  // body-parser throws a 400 SyntaxError on malformed JSON, which would break
  // the contract's central promise: a validly signed request always gets a 2xx.
  // The raw bytes are already captured above and the service re-parses them
  // itself, so the parse failure is swallowed here and surfaces later as a
  // stored FAILED event instead of a 400 the sender will retry forever.
  app.use(
    WEBHOOK_PATH_PREFIX,
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
