import { Injectable } from '@nestjs/common';

import { PermissionsRepository } from './repositories/permissions.repository';
import type { PermissionItem } from './serializers/permission.serializer';

@Injectable()
export class PermissionsService {
  constructor(private readonly repository: PermissionsRepository) {}

  findAll(): Promise<PermissionItem[]> {
    return this.repository.findAll();
  }
}
