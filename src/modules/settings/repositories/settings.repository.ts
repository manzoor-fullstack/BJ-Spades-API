import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

export interface StoredSetting {
  key: string;
  value: Prisma.JsonValue;
}

export interface SettingUpsert {
  key: string;
  value: string | number | boolean;
  category: string;
  description: string;
  isProtected: boolean;
}

@Injectable()
export class SettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every stored row. A key with no row falls back to its registry default, so
   * a fresh database needs no seed to serve `GET /settings` correctly.
   */
  findAll(): Promise<StoredSetting[]> {
    return this.prisma.settings.findMany({
      select: { key: true, value: true },
      orderBy: { key: 'asc' },
    });
  }

  /**
   * Writes the supplied keys and leaves every other key untouched.
   *
   * One transaction: a settings save is presented to the operator as a single
   * action, and half of it landing is worse than none of it landing.
   */
  async upsertMany(
    entries: SettingUpsert[],
    updatedByAdminId: string | null,
  ): Promise<void> {
    if (entries.length === 0) return;

    await this.prisma.$transaction(
      entries.map((entry) =>
        this.prisma.settings.upsert({
          where: { key: entry.key },
          update: {
            value: entry.value,
            category: entry.category,
            description: entry.description,
            isProtected: entry.isProtected,
            updatedByAdminId,
          },
          create: {
            key: entry.key,
            value: entry.value,
            category: entry.category,
            description: entry.description,
            isProtected: entry.isProtected,
            updatedByAdminId,
          },
        }),
      ),
    );
  }
}
