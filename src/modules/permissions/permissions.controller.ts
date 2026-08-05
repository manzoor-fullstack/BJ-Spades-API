import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PERMISSION_CODES } from '../../common/constants/permissions';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';

import { PermissionsService } from './permissions.service';

// Read-only, and gated on roles.manage rather than a permission of its own:
// the only screen that needs the catalogue is the role permissions modal
// (docs/03-API-CONTRACT.md).
@ApiTags('permissions')
@ApiBearerAuth('access-token')
@RequirePermissions(PERMISSION_CODES.ROLES_MANAGE)
@Controller('permissions')
export class PermissionsController {
  constructor(private readonly permissionsService: PermissionsService) {}

  @Get()
  @ApiOperation({
    summary: 'The permission catalogue: code, name and description',
  })
  findAll() {
    return this.permissionsService.findAll();
  }
}
