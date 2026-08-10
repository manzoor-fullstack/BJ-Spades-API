import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ActivityCategory } from '@prisma/client';

import { ACTIVITY_ACTIONS } from '../../common/constants/activity-actions';
import { PERMISSION_CODES } from '../../common/constants/permissions';
import {
  AuditLog,
  readString,
  type AuditContext,
} from '../../common/decorators/audit-log.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../auth/interfaces/authenticated-admin.interface';

import { ClaimsService } from './claims.service';
import {
  ApproveClaimDto,
  DeclineClaimDto,
  QueryClaimsDto,
} from './dto/claim.dto';

/** The audited subject: who claimed what, not a bare UUID. */
function claimLabel(ctx: AuditContext, result: unknown): string {
  const prize = readString(result, 'prizeDescription');

  return prize ?? ctx.params.id ?? 'claim';
}

function claimId(ctx: AuditContext, result: unknown): string | undefined {
  return readString(result, 'id') ?? ctx.params.id;
}

/**
 * Route order matters: `stats` is declared before `:id` because Nest matches in
 * declaration order, and declared after it `GET /claims/stats` would be served
 * by `findOne('stats')` and fail the UUID pipe.
 *
 * Gated on the payout permissions rather than its own: a claim decides whether
 * money is owed, so anyone who can act on payouts can act on claims, and nobody
 * else.
 */
@ApiTags('claims')
@ApiBearerAuth('access-token')
@Controller('claims')
export class ClaimsController {
  constructor(private readonly claimsService: ClaimsService) {}

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get()
  @ApiOperation({
    summary:
      'List prize claims, oldest first — the tab is a review queue, so the ' +
      'claim that has waited longest comes first.',
  })
  findAll(@Query() query: QueryClaimsDto) {
    return this.claimsService.findAll(query);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get('stats')
  @ApiOperation({
    summary:
      'The four Claims cards. Average review time is null when nothing has ' +
      'been decided in 30 days — zero would read as instant.',
  })
  stats() {
    return this.claimsService.stats();
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get(':id')
  @ApiOperation({ summary: 'Fetch one claim' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.claimsService.findOne(id);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @AuditLog({
    category: ActivityCategory.PAYOUT,
    action: ACTIVITY_ACTIONS.CLAIM_APPROVED.code,
    title: (ctx, result) => `Claim approved: ${claimLabel(ctx, result)}`,
    entityType: 'PrizeClaim',
    entityId: claimId,
  })
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Approve a claim. Refused with 422 when the player never accepted the ' +
      'prize terms — approving would record consent that was not given.',
  })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveClaimDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.claimsService.approve(id, dto, admin);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @AuditLog({
    category: ActivityCategory.PAYOUT,
    action: ACTIVITY_ACTIONS.CLAIM_DECLINED.code,
    title: (ctx, result) => `Claim declined: ${claimLabel(ctx, result)}`,
    entityType: 'PrizeClaim',
    entityId: claimId,
    metadata: (ctx) => ({ reason: readString(ctx.body, 'reason') }),
  })
  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline a claim. A reason is required.' })
  decline(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeclineClaimDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.claimsService.decline(id, dto, admin);
  }
}
