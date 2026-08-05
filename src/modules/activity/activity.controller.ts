import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PERMISSION_CODES } from '../../common/constants/permissions';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';

import { ActivityLogService } from './activity.service';
import {
  QueryActivityDto,
  RecentActivityQueryDto,
} from './dto/query-activity.dto';

/**
 * Read-only by design. Entries are written by AuditInterceptor and by services
 * on paths the interceptor cannot see — never by an HTTP call, which would let
 * an admin forge their own audit trail.
 */
@ApiTags('activity')
@ApiBearerAuth('access-token')
@Controller('activity')
export class ActivityController {
  constructor(private readonly activityLogService: ActivityLogService) {}

  @RequirePermissions(PERMISSION_CODES.ACTIVITY_VIEW)
  @Get()
  @ApiOperation({
    summary: 'List activity entries, newest first, with filters and search',
  })
  findAll(@Query() query: QueryActivityDto) {
    return this.activityLogService.findAll(query);
  }

  @RequirePermissions(PERMISSION_CODES.ACTIVITY_VIEW)
  @Get('recent')
  @ApiOperation({ summary: 'The newest entries, for the dashboard sidebar' })
  recent(@Query() query: RecentActivityQueryDto) {
    return this.activityLogService.findRecent(query.limit);
  }
}
