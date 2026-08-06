import { mkdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';

/**
 * URL prefix the uploads directory is served under.
 *
 * Not `/api/uploads`: `useStaticAssets` registers Express middleware, which
 * knows nothing about `setGlobalPrefix('api')`. `LocalDiskStorageService.getUrl`
 * builds the same path, so the two must be changed together.
 */
export const UPLOADS_ROUTE_PREFIX = '/uploads';

/**
 * Serves `UPLOAD_DIR` at `/uploads` (docs/phases/PHASE-4.md, 4.7).
 *
 * Called from `main.ts` and from `test/create-test-app.ts` so the integration
 * suite fetches uploaded images over exactly the same path production does.
 *
 * In production this should sit behind a reverse proxy or CDN — having Node
 * serve image bytes spends application bandwidth and event-loop time on work
 * nginx does better (ADR-003).
 */
export function applyStaticAssets(app: NestExpressApplication): void {
  const config = app.get(ConfigService);
  const uploadDir = config.get<string>('app.uploadDir') ?? './uploads';

  const rootDir = isAbsolute(uploadDir)
    ? uploadDir
    : resolve(process.cwd(), uploadDir);

  // express.static on a missing directory answers 404 for everything and never
  // recovers once the directory appears, so create it up front.
  mkdirSync(rootDir, { recursive: true });

  app.useStaticAssets(rootDir, {
    prefix: UPLOADS_ROUTE_PREFIX,
    // Uploads are immutable: the key contains a UUID, so a changed image is a
    // different URL and this can be cached hard.
    maxAge: '365d',
    immutable: true,
    // No directory listing, and no falling through to index.html.
    index: false,
    redirect: false,
    // Never serve a dotfile out of the upload directory.
    dotfiles: 'ignore',
  });
}
