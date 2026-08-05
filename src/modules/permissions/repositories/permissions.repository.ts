import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import type { PermissionItem } from '../serializers/permission.serializer';

@Injectable()
export class PermissionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ordered by code so the modal's checkbox order is stable between loads —
   * an unordered findMany would shuffle rows as the table is written to.
   */
  findAll(): Promise<PermissionItem[]> {
    return this.prisma.permission.findMany({
      select: { code: true, name: true, description: true },
      orderBy: { code: 'asc' },
    });
  }
}
