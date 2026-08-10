import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ActivityCategory } from '@prisma/client';
import type { Request, Response } from 'express';

import { ACTIVITY_ACTIONS } from '../../common/constants/activity-actions';
import { PERMISSION_CODES } from '../../common/constants/permissions';
import {
  AuditLog,
  readString,
  type AuditContext,
} from '../../common/decorators/audit-log.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { AuthenticatedAdmin } from '../auth/interfaces/authenticated-admin.interface';
import type { RawBodyRequest } from '../webhooks/webhook-raw-body';

import { CancelPayoutDto } from './dto/payout-action.dto';
import { QueryPayoutsDto } from './dto/query-payouts.dto';
import { QueryPrizeDistributionDto } from './dto/query-prize-distribution.dto';
import { PayoutsService } from './payouts.service';

/** The audited subject: the amount and recipient, not a bare UUID. */
function payoutLabel(ctx: AuditContext, result: unknown): string {
  const amount = readString(result, 'amount');

  return amount ? `${amount}` : (ctx.params.id ?? 'payout');
}

function payoutId(ctx: AuditContext, result: unknown): string | undefined {
  return readString(result, 'id') ?? ctx.params.id;
}

/**
 * Route order is significant. `stats` and the two `stripe/*` routes are
 * declared before `:id` because Nest matches in declaration order — declared
 * after, `GET /payouts/stats` would be served by `findOne('stats')` and fail
 * the UUID pipe.
 */
@ApiTags('payouts')
@ApiBearerAuth('access-token')
@Controller('payouts')
export class PayoutsController {
  constructor(private readonly payoutsService: PayoutsService) {}

  /**
   * Declared first of all: `@Public()`, and it must never be shadowed by an
   * authenticated route. Stripe's signature is the only credential it carries.
   */
  @Public()
  @Post('stripe/webhook')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  handleStripeWebhook(
    @Req() request: Request & RawBodyRequest,
    @Headers('stripe-signature') signature: string | undefined,
  ) {
    // The RAW bytes, captured by applyStripeRawBodyParser before Nest's own
    // parser ran. Verifying against `request.body` would re-serialise the
    // payload and fail every signature check.
    return this.payoutsService.handleWebhook(request.rawBody, signature);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get()
  @ApiOperation({
    summary:
      'List payouts with pagination, status/method/user/tournament filters, ' +
      'a date range over owedSince, and search across recipient and tournament',
  })
  findAll(@Query() query: QueryPayoutsDto) {
    return this.payoutsService.findAll(query);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get('stats')
  @ApiOperation({
    summary:
      'Aggregates powering the payout cards. Every money figure is a ' +
      'two-decimal string. No escrow figure — see D-12.',
  })
  stats() {
    return this.payoutsService.stats();
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get('history/export')
  @ApiOperation({
    summary:
      'Stream the payout history as CSV, honouring the same filters. One flat ' +
      'row per transaction — a spreadsheet wants facts, not nested groups.',
  })
  @ApiOkResponse({ description: 'A text/csv attachment.' })
  async exportHistoryCsv(
    @Query() query: QueryPayoutsDto,
    // @Res() puts this handler in library-specific mode: nothing is returned
    // to Nest, so TransformInterceptor never wraps the body in the JSON
    // envelope and the client receives raw CSV.
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${this.payoutsService.exportFilename()}"`,
    );

    for await (const chunk of this.payoutsService.streamHistoryCsv(query)) {
      response.write(chunk);
    }

    response.end();
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get('history/stats')
  @ApiOperation({ summary: 'The four History cards.' })
  historyStats() {
    return this.payoutsService.historyStats();
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get('history')
  @ApiOperation({
    summary:
      'Lifetime prizes, withdrawals and refunds grouped by player. Paging is ' +
      'over transactions, not player blocks.',
  })
  history(@Query() query: QueryPayoutsDto) {
    return this.payoutsService.history(query);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get('tracker')
  @ApiOperation({
    summary:
      'Payouts as six-step progress rails. Takes the same query as GET ' +
      '/payouts — the tracker is a different rendering of the same rows, so ' +
      'search, the status filter and the date range behave identically.',
  })
  tracker(@Query() query: QueryPayoutsDto) {
    return this.payoutsService.tracker(query);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get('tracker/stats')
  @ApiOperation({
    summary:
      'The four Tracker cards. `awaitingAction` overlaps `activePayouts` by ' +
      'design: one is what is in flight, the other is what needs an operator.',
  })
  trackerStats() {
    return this.payoutsService.trackerStats();
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get('tournaments')
  @ApiOperation({
    summary:
      'Tournaments that have recorded results, for the Overview tab selector. ' +
      'Gated on payouts.view so the payouts page needs one permission, not two.',
  })
  payoutTournaments() {
    return this.payoutsService.payoutTournaments();
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get('prize-distribution')
  @ApiOperation({
    summary:
      'Winners, placement, prize and payout status for one tournament. ' +
      '`currency` filters; it does not convert — there is no FX rate source.',
  })
  prizeDistribution(@Query() query: QueryPrizeDistributionDto) {
    return this.payoutsService.prizeDistribution(query);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @AuditLog({
    category: ActivityCategory.PAYOUT,
    action: ACTIVITY_ACTIONS.PAYOUT_STRIPE_ONBOARDING_STARTED.code,
    title: (ctx) => `Stripe onboarding started for user ${ctx.params.userId}`,
    entityType: 'User',
    entityId: (ctx) => ctx.params.userId,
  })
  @Post('stripe/onboard/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Create the Stripe Express account if absent and return a hosted ' +
      'onboarding link. The admin sends the link out of band — Milestone 1 ' +
      'has no player app to redirect into.',
  })
  onboard(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.payoutsService.createOnboardingLink(userId, admin);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get(':id')
  @ApiOperation({ summary: 'Fetch one payout' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.payoutsService.findOne(id);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @AuditLog({
    category: ActivityCategory.PAYOUT,
    action: ACTIVITY_ACTIONS.PAYOUT_APPROVED.code,
    title: (ctx, result) => `Payout of ${payoutLabel(ctx, result)} approved`,
    entityType: 'Payout',
    entityId: payoutId,
  })
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Approve a payout for sending. Approval moves no money — that is /process.',
  })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.payoutsService.approve(id, admin);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @AuditLog({
    category: ActivityCategory.PAYOUT,
    action: ACTIVITY_ACTIONS.PAYOUT_PROCESSED.code,
    title: (ctx, result) => `Payout of ${payoutLabel(ctx, result)} processed`,
    entityType: 'Payout',
    entityId: payoutId,
    metadata: (_ctx, result) => ({
      stripeTransferId: readString(result, 'stripeTransferId'),
      amount: readString(result, 'amount'),
    }),
  })
  @Post(':id/process')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Execute the Stripe Connect transfer. Requires APPROVED, a VERIFIED ' +
      'recipient, no existing transfer, and a positive amount — each a 422 ' +
      'with its own message.',
  })
  process(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.payoutsService.process(id, admin);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @AuditLog({
    category: ActivityCategory.PAYOUT,
    action: ACTIVITY_ACTIONS.PAYOUT_CANCELLED.code,
    title: (ctx, result) => `Payout of ${payoutLabel(ctx, result)} cancelled`,
    entityType: 'Payout',
    entityId: payoutId,
  })
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a payout that has not been sent. A reason is required.',
  })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() cancelPayoutDto: CancelPayoutDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.payoutsService.cancel(id, cancelPayoutDto, admin);
  }
}
