import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PERMISSION_CODES } from '../../common/constants/permissions';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';

import {
  ConnectPayoutMethodDto,
  QueryPayoutMethodsDto,
} from './dto/payout-method.dto';
import { PayoutMethodsService } from './payout-methods.service';

/**
 * Where players want money sent.
 *
 * Recording an account here does NOT make that rail payable — only Stripe
 * Connect can be executed, and `PayoutsService.process` refuses everything
 * else with 422. Every row carries `isExecutable` so the UI can say so
 * plainly rather than implying a connected Zelle account means Zelle payouts
 * go out on their own.
 */
@ApiTags('payout-methods')
@ApiBearerAuth('access-token')
@Controller('payout-methods')
export class PayoutMethodsController {
  constructor(private readonly service: PayoutMethodsService) {}

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get()
  @ApiOperation({ summary: 'List connected payout methods, defaults first' })
  findAll(@Query() query: QueryPayoutMethodsDto) {
    return this.service.findAll(query);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @Post('connect')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Record where a player wants money sent. Upserts — one account per rail ' +
      'per player, enforced by a unique constraint rather than a race.',
  })
  connect(@Body() dto: ConnectPayoutMethodDto) {
    return this.service.connect(dto);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @Post(':id/default')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Make this the default, clearing the flag from the same player other ' +
      'accounts in one transaction. Two defaults would leave an operator ' +
      'guessing which one a payout uses.',
  })
  setDefault(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.setDefault(id);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @Post(':id/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Record that an admin confirmed the destination belongs to the player. ' +
      'A human decision, not an automated check.',
  })
  verify(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.setVerified(id, true);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @Delete(':id')
  @ApiOperation({ summary: 'Disconnect a payout method' })
  disconnect(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.disconnect(id);
  }
}
