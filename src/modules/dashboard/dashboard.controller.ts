import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { PERMISSION_CODES } from '../../common/constants/permissions';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';

import { DashboardService } from './dashboard.service';
import { DashboardStatsDto } from './dto/dashboard-stats.dto';

@ApiTags('dashboard')
@ApiBearerAuth('access-token')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @RequirePermissions(PERMISSION_CODES.DASHBOARD_VIEW)
  @Get('stats')
  @ApiOperation({
    summary: 'The four dashboard cards, each a real aggregate',
    description:
      'Cached in memory for 60 seconds. Percentage fields are null when the previous period has no baseline to compare against.',
  })
  @ApiResponse({ status: 200, type: DashboardStatsDto })
  getStats(): Promise<DashboardStatsDto> {
    return this.dashboardService.getStats();
  }
}
