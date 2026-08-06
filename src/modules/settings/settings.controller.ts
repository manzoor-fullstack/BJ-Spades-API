import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { PERMISSION_CODES } from '../../common/constants/permissions';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { extractRequestContext } from '../../common/http/request-context.util';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../auth/interfaces/authenticated-admin.interface';

import { UpdateSettingsDto } from './dto/update-settings.dto';
import { SettingsService } from './settings.service';

@ApiTags('settings')
@ApiBearerAuth('access-token')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @RequirePermissions(PERMISSION_CODES.SETTINGS_MANAGE)
  @Get()
  @ApiOperation({
    summary: 'Every setting, grouped by the card it belongs to',
    description:
      'Keys with no stored row are returned at their registry default, so a fresh installation needs no seed.',
  })
  getSettings() {
    return this.settingsService.getGrouped();
  }

  @RequirePermissions(PERMISSION_CODES.SETTINGS_MANAGE)
  @Put()
  @ApiOperation({
    summary: 'Update the supplied settings and leave the rest untouched',
    description:
      'An unknown key is rejected with 400 rather than stored, and every value is checked against the bounds declared in the registry. The audit entry carries a before/after diff.',
  })
  @ApiResponse({ status: 400, description: 'Unknown key or invalid value' })
  updateSettings(
    @Body() updateSettingsDto: UpdateSettingsDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ) {
    return this.settingsService.update(
      updateSettingsDto,
      admin.id,
      extractRequestContext(request),
    );
  }
}
