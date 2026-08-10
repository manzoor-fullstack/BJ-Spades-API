import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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

import {
  CreateSponsorDto,
  QuerySponsorsDto,
  UpdateSponsorDto,
} from './dto/sponsor.dto';
import { SponsorsService } from './sponsors.service';

/** The audited subject: the sponsor's name, not a bare UUID. */
function sponsorName(ctx: AuditContext, result: unknown): string {
  return (
    readString(result, 'name') ?? readString(ctx.body, 'name') ?? 'sponsor'
  );
}

function sponsorId(ctx: AuditContext, result: unknown): string | undefined {
  return readString(result, 'id') ?? ctx.params.id;
}

/**
 * Gated on the payout permissions: a sponsor funds a prize, so the roster
 * belongs to whoever manages what gets paid out.
 */
@ApiTags('sponsors')
@ApiBearerAuth('access-token')
@Controller('sponsors')
export class SponsorsController {
  constructor(private readonly sponsorsService: SponsorsService) {}

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get()
  @ApiOperation({
    summary: 'List sponsors, active first then alphabetical, with search',
  })
  findAll(@Query() query: QuerySponsorsDto) {
    return this.sponsorsService.findAll(query);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get(':id')
  @ApiOperation({ summary: 'Fetch one sponsor' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.sponsorsService.findOne(id);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @AuditLog({
    category: ActivityCategory.PAYOUT,
    action: ACTIVITY_ACTIONS.SPONSOR_CREATED.code,
    title: (ctx, result) => `Sponsor added: ${sponsorName(ctx, result)}`,
    entityType: 'Sponsor',
    entityId: sponsorId,
  })
  @Post()
  @ApiOperation({ summary: 'Add a sponsor' })
  create(@Body() dto: CreateSponsorDto) {
    return this.sponsorsService.create(dto);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @AuditLog({
    category: ActivityCategory.PAYOUT,
    action: ACTIVITY_ACTIONS.SPONSOR_UPDATED.code,
    title: (ctx, result) => `Sponsor updated: ${sponsorName(ctx, result)}`,
    entityType: 'Sponsor',
    entityId: sponsorId,
  })
  @Patch(':id')
  @ApiOperation({ summary: 'Update a sponsor' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSponsorDto,
  ) {
    return this.sponsorsService.update(id, dto);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @AuditLog({
    category: ActivityCategory.PAYOUT,
    action: ACTIVITY_ACTIONS.SPONSOR_DELETED.code,
    title: (ctx, result) => `Sponsor removed: ${sponsorName(ctx, result)}`,
    entityType: 'Sponsor',
    entityId: sponsorId,
  })
  @Delete(':id')
  @ApiOperation({
    summary:
      'Remove a sponsor. High priority in the audit log — it removes the ' +
      'record of who funded a prize.',
  })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.sponsorsService.remove(id);
  }
}
