import { Inject, Injectable, Logger } from '@nestjs/common';
import type { MediaAsset } from '@prisma/client';

import { ImageProcessorService } from './image-processor.service';
import type { ValidatableUpload } from './image-validation';
import { MediaRepository } from './repositories/media.repository';
import { STORAGE_SERVICE, type StorageService } from './storage.interface';

/**
 * How long a freshly uploaded asset is protected from orphan cleanup.
 *
 * An asset is created before the row that references it, so between those two
 * writes every new upload *looks* like an orphan. Without this grace window a
 * cleanup running at the wrong moment would delete the banner of a tournament
 * being created in another request.
 */
export const ORPHAN_GRACE_PERIOD_MS = 60 * 60 * 1000;

export interface OrphanCleanupResult {
  scanned: number;
  deleted: number;
}

/**
 * Turns an uploaded file into a persisted `MediaAsset`, and takes it away again.
 *
 * Owns the ordering that matters: bytes are validated and re-encoded, then
 * written to storage, and only then is a row created. Writing the row first
 * would leave a dangling reference whenever the disk write failed.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly repository: MediaRepository,
    private readonly imageProcessor: ImageProcessorService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  async uploadImage(
    file: ValidatableUpload,
    folder: string,
    uploadedByAdminId: string | null,
  ): Promise<MediaAsset> {
    const processed = await this.imageProcessor.process(file);

    const stored = await this.storage.upload(
      { buffer: processed.buffer, mimetype: processed.mimeType },
      folder,
    );

    return this.repository.create({
      key: stored.key,
      url: stored.url,
      mimeType: processed.mimeType,
      // Measured from the file that was actually written, not from the
      // Content-Length the client supplied.
      sizeBytes: processed.sizeBytes,
      width: processed.width,
      height: processed.height,
      uploadedByAdminId,
    });
  }

  /**
   * Deletes the row and then the bytes.
   *
   * Row first: a `MediaAsset` pointing at a missing file renders a broken
   * image, while a file with no row is invisible and reclaimable by the orphan
   * sweep below. Given one of the two writes must happen first, leaving the
   * recoverable failure is the right way round.
   *
   * Never throws. Callers use it while deleting a tournament, and a storage
   * hiccup must not abort that.
   */
  async deleteAsset(assetId: string | null | undefined): Promise<void> {
    if (!assetId) {
      return;
    }

    const asset = await this.repository.findById(assetId);

    if (!asset) {
      return;
    }

    try {
      await this.repository.deleteById(asset.id);
      await this.storage.delete(asset.key);
    } catch (error) {
      this.logger.error(
        `Failed to delete media asset ${assetId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Deletes assets nothing references, together with their files.
   *
   * Exposed as a plain method with no scheduler behind it: `@nestjs/schedule`
   * is not a dependency of this project, so this is invoked deliberately — from
   * a maintenance script or an ops endpoint — rather than on a timer nobody
   * remembers exists.
   */
  async cleanupOrphans(now: Date = new Date()): Promise<OrphanCleanupResult> {
    const cutoff = new Date(now.getTime() - ORPHAN_GRACE_PERIOD_MS);
    const orphans = await this.repository.findOrphans(cutoff);

    let deleted = 0;

    for (const orphan of orphans) {
      try {
        await this.repository.deleteById(orphan.id);
        await this.storage.delete(orphan.key);
        deleted += 1;
      } catch (error) {
        this.logger.error(
          `Failed to clean up orphaned asset ${orphan.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (deleted > 0) {
      this.logger.log(`Cleaned up ${deleted} orphaned media asset(s)`);
    }

    return { scanned: orphans.length, deleted };
  }
}
