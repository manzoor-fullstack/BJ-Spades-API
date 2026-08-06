import { Module } from '@nestjs/common';

import { ImageProcessorService } from './image-processor.service';
import { LocalDiskStorageService } from './local-disk-storage.service';
import { MediaService } from './media.service';
import { MediaRepository } from './repositories/media.repository';
import { STORAGE_SERVICE } from './storage.interface';

/**
 * Binds the storage token to a backend (docs/01-ARCHITECTURE.md, ADR-003).
 *
 * Migrating to Cloudinary is this one line:
 *
 *   { provide: STORAGE_SERVICE, useClass: CloudinaryStorageService }
 *
 * Nothing in the tournaments, rewards or merchandise modules changes, because
 * none of them ever named a concrete implementation.
 */
@Module({
  providers: [
    { provide: STORAGE_SERVICE, useClass: LocalDiskStorageService },
    ImageProcessorService,
    MediaRepository,
    MediaService,
  ],
  exports: [STORAGE_SERVICE, MediaService, ImageProcessorService],
})
export class StorageModule {}
