import { Injectable } from '@nestjs/common';
import type { MediaAsset } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

export interface CreateMediaAssetData {
  key: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  uploadedByAdminId: string | null;
}

/**
 * The only place `MediaAsset` rows are read or written.
 *
 * Keeping Prisma behind this boundary is what lets MediaService be unit-tested
 * without a database, and is the layering rule the whole API follows:
 * controller → service → repository.
 */
@Injectable()
export class MediaRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: CreateMediaAssetData): Promise<MediaAsset> {
    return this.prisma.mediaAsset.create({ data });
  }

  findById(id: string): Promise<MediaAsset | null> {
    return this.prisma.mediaAsset.findUnique({ where: { id } });
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.mediaAsset.delete({ where: { id } });
  }

  /**
   * Assets no entity points at any more.
   *
   * Every relation declared on `MediaAsset` must appear here. An omitted one
   * makes the assets it references look unreferenced, and the cleanup below
   * deletes them while they are still on screen — a tournament banner, a reward
   * icon or a product photo silently turning into a broken image.
   *
   * Phase 5 added `rewards` and `merchandise`; a future phase adding another
   * relation must extend this list in the same commit.
   *
   * Soft-deleted rewards and merchandise still count as references: their rows
   * survive precisely so history stays intact, and a restored item with no image
   * would be a poor trade for one reclaimed file.
   *
   * `createdBefore` is not optional by accident — see MediaService.
   */
  findOrphans(createdBefore: Date): Promise<MediaAsset[]> {
    return this.prisma.mediaAsset.findMany({
      where: {
        createdAt: { lt: createdBefore },
        tournaments: { none: {} },
        rewards: { none: {} },
        merchandise: { none: {} },
      },
    });
  }
}
