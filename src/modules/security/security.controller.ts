import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ActivityCategory } from '@prisma/client';

import { ACTIVITY_ACTIONS } from '../../common/constants/activity-actions';
import { PERMISSION_CODES } from '../../common/constants/permissions';
import {
  AuditLog,
  readString,
} from '../../common/decorators/audit-log.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../auth/interfaces/authenticated-admin.interface';

import { QuerySecurityAlertsDto } from './dto/query-security-alerts.dto';
import { SecurityService } from './security.service';

function readNumber(source: unknown, key: string): number | undefined {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }

  const value = (source as Record<string, unknown>)[key];

  return typeof value === 'number' ? value : undefined;
}

@ApiTags('security')
@ApiBearerAuth('access-token')
@Controller('security')
export class SecurityController {
  constructor(private readonly securityService: SecurityService) {}

  @RequirePermissions(PERMISSION_CODES.SECURITY_MANAGE)
  @Get('sessions')
  @ApiOperation({
    summary: 'Every live session, across all admins',
    description:
      'Device, browser, OS, IP and last activity as recorded at sign-in. The session the request is authenticated with is flagged `isCurrent`.',
  })
  findSessions(@CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.securityService.findSessions(admin);
  }

  @RequirePermissions(PERMISSION_CODES.SECURITY_MANAGE)
  @Get('stats')
  @ApiOperation({
    summary:
      'Active sessions, failed sign-ins in 24h, high-priority events in 7d',
    description:
      'Three figures, each backed by rows. There is deliberately no security score, blocked-IP count or verified-session count — none has a data source (D-04, D-05, D-07).',
  })
  stats() {
    return this.securityService.stats();
  }

  @RequirePermissions(PERMISSION_CODES.SECURITY_MANAGE)
  @Get('alerts')
  @ApiOperation({
    summary: 'Security-relevant activity, paginated',
    description:
      'Read from ActivityLog: everything filed under SECURITY plus everything flagged high priority. Real events — failed sign-ins, suspensions, balance adjustments, revocations (D-06).',
  })
  findAlerts(@Query() query: QuerySecurityAlertsDto) {
    return this.securityService.findAlerts(query);
  }

  @RequirePermissions(PERMISSION_CODES.SECURITY_MANAGE)
  @AuditLog({
    category: ActivityCategory.SECURITY,
    action: ACTIVITY_ACTIONS.SECURITY_SESSION_REVOKED.code,
    title: (ctx) => `Session ${ctx.params.id} revoked`,
    entityType: 'Session',
    entityId: (ctx) => ctx.params.id,
    metadata: (ctx, result) => ({
      scope: 'one',
      sessionId: ctx.params.id,
      revokedAdminId: readString(result, 'adminId'),
      device: readString(result, 'device'),
      ipAddress: readString(result, 'ipAddress'),
    }),
  })
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke one session',
    description:
      'Takes effect on the next request the revoked device makes, not when its access token would have expired. Revoking your own session is refused — sign out instead.',
  })
  @ApiResponse({ status: 204, description: 'Session revoked' })
  @ApiResponse({ status: 400, description: 'That is your own session' })
  @ApiResponse({ status: 404, description: 'No such active session' })
  async revokeSession(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<void> {
    await this.securityService.revokeSession(id, admin);
  }

  @RequirePermissions(PERMISSION_CODES.SECURITY_MANAGE)
  @AuditLog({
    category: ActivityCategory.SECURITY,
    action: ACTIVITY_ACTIONS.SECURITY_SESSION_REVOKED.code,
    title: (_ctx, result) =>
      `${readNumber(result, 'revoked') ?? 0} sessions revoked`,
    entityType: 'Session',
    metadata: (_ctx, result) => ({
      scope: 'all',
      revoked: readNumber(result, 'revoked'),
    }),
  })
  @Delete('sessions')
  @ApiOperation({
    summary: 'Revoke every other live session',
    description:
      "Signs every other device on the platform out. The caller's own session is spared so they stay signed in.",
  })
  revokeAllOtherSessions(@CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.securityService.revokeAllOtherSessions(admin);
  }
}
