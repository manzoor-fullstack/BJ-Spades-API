import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { setupSwagger } from './config/swagger.config';
import { applyStaticAssets } from './modules/storage/static-assets';
import { applyStripeRawBodyParser } from './modules/stripe/stripe-raw-body';
import { applyWebhookRawBodyParser } from './modules/webhooks/webhook-raw-body';

function parseCorsOrigins(raw: string | undefined): string[] | false {
  const origins = (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  // Defaulting to `false` rather than `true` means a missing CORS_ORIGINS
  // fails closed. Under the BFF architecture the browser never calls this API
  // directly, so an empty list is the correct production posture (ADR-001).
  return origins.length > 0 ? origins : false;
}

async function bootstrap(): Promise<void> {
  // Typed as NestExpressApplication for `useStaticAssets`, which serves
  // UPLOAD_DIR at /uploads (Phase 4.7).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  const port = config.get<number>('app.port') ?? 5000;
  const nodeEnv = config.get<string>('app.nodeEnv') ?? 'development';
  const isProduction = nodeEnv === 'production';

  // FIRST, before the global prefix, pipes, or anything else that could pull
  // in Nest's own body parser. Nest registers that parser during app.init(),
  // and Express runs middleware in registration order — so the raw-body hook
  // has to be installed before then or /api/webhooks never sees the bytes that
  // were actually signed. Scoped to /api/webhooks; the rest of the API keeps
  // Nest's default body handling untouched.
  applyWebhookRawBodyParser(app);

  // Same concern, different path: Stripe signs the raw bytes of its webhook
  // body, and Nest's parser would hand the controller a re-serialised object.
  applyStripeRawBodyParser(app);

  // After the raw-body hook, before the global prefix: uploads are served at
  // /uploads, outside the /api namespace, because express.static is registered
  // on the Express instance and never sees setGlobalPrefix.
  applyStaticAssets(app);

  app.setGlobalPrefix('api');

  app.use(helmet());

  app.enableCors({
    origin: parseCorsOrigins(config.get<string>('app.corsOrigins')),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip properties that have no decorator on the DTO.
      whitelist: true,
      // Reject outright when unknown properties are sent, rather than
      // silently dropping them.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  if (!isProduction) {
    setupSwagger(app);
  }

  app.enableShutdownHooks();

  await app.listen(port);

  logger.log(`Server running on http://localhost:${port}/api`);
  if (!isProduction) {
    logger.log(`Swagger UI at http://localhost:${port}/api/docs`);
  }
}

void bootstrap();
