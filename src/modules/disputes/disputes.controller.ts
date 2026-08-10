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

import { DisputesService } from './disputes.service';
import { QueryDisputesDto, ResolveDisputeDto } from './dto/dispute.dto';

/** The audited subject: the case number, which a person can actually quote. */
function caseLabel(ctx: AuditContext, result: unknown): string {
  return readString(result, 'caseNumber') ?? ctx.params.id ?? 'dispute';
}

function disputeId(ctx: AuditContext, result: unknown): string | undefined {
  return readString(result, 'id') ?? ctx.params.id;
}

/**
 * `stats` before `:id` — Nest matches in declaration order, and the other way
 * round `GET /disputes/stats` would hit the UUID pipe.
 *
 * Gated on the payout permissions: a disqualification stops money being owed,
 * so it belongs to whoever can act on payouts.
 */
@ApiTags('disputes')
@ApiBearerAuth('access-token')
@Controller('disputes')
export class DisputesController {
  constructor(private readonly disputesService: DisputesService) {}

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get()
  @ApiOperation({
    summary:
      'List anti-cheat cases and appeals, newest first, with search plus ' +
      'status and risk filters.',
  })
  findAll(@Query() query: QueryDisputesDto) {
    return this.disputesService.findAll(query);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get('stats')
  @ApiOperation({
    summary:
      'The four Disputes cards. High/critical counts OPEN cases only — a ' +
      'resolved critical case needs no action.',
  })
  stats() {
    return this.disputesService.stats();
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get(':id')
  @ApiOperation({ summary: 'Fetch one case' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.disputesService.findOne(id);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @AuditLog({
    category: ActivityCategory.PAYOUT,
    action: ACTIVITY_ACTIONS.DISPUTE_CLEARED.code,
    title: (ctx, result) => `Dispute cleared: ${caseLabel(ctx, result)}`,
    entityType: 'Dispute',
    entityId: disputeId,
    metadata: (ctx) => ({ note: readString(ctx.body, 'note') }),
  })
  @Post(':id/clear')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Clear a case. A note is required.' })
  clear(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveDisputeDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.disputesService.clear(id, dto, admin);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @AuditLog({
    category: ActivityCategory.PAYOUT,
    action: ACTIVITY_ACTIONS.DISPUTE_DISQUALIFIED.code,
    title: (ctx, result) => `Player disqualified: ${caseLabel(ctx, result)}`,
    entityType: 'Dispute',
    entityId: disputeId,
    metadata: (ctx) => ({ note: readString(ctx.body, 'note') }),
  })
  @Post(':id/disqualify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Disqualify the player on this case. A note is required — a ' +
      'disqualification with no stated reason cannot be defended later.',
  })
  disqualify(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveDisputeDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.disputesService.disqualify(id, dto, admin);
  }
}
