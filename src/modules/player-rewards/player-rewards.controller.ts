import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { PERMISSION_CODES } from '../../common/constants/permissions';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentPlayer } from '../player-auth/decorators/current-player.decorator';
import { PlayerCsrfGuard } from '../player-auth/guards/player-csrf.guard';
import { PlayerJwtGuard } from '../player-auth/guards/player-jwt.guard';
import type { AuthenticatedPlayer } from '../player-auth/interfaces/player-jwt-payload.interface';
import { CreateRedemptionDto } from './dto/create-redemption.dto';
import { FulfillRedemptionDto } from './dto/fulfill-redemption.dto';
import { PlayerRewardsService } from './player-rewards.service';

@ApiTags('player-rewards')
@Public()
@UseGuards(PlayerJwtGuard)
@Controller('player/v1')
export class PlayerRewardsController {
  constructor(private readonly service: PlayerRewardsService) {}

  @Get('rewards')
  catalog() {
    return this.service.catalog();
  }

  @Get('me/redemptions')
  list(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.list(player.id);
  }

  @Get('me/redemptions/:id')
  findOne(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(player.id, id);
  }

  @Post('me/redemptions')
  @UseGuards(PlayerCsrfGuard)
  create(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Body() input: CreateRedemptionDto,
  ) {
    return this.service.create(player.id, input);
  }

  @Post('me/redemptions/:id/cancel')
  @UseGuards(PlayerCsrfGuard)
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.cancel(player.id, id);
  }

  @Post('me/redemptions/:id/redeem')
  @UseGuards(PlayerCsrfGuard)
  @HttpCode(HttpStatus.OK)
  redeem(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.redeem(player.id, id);
  }
}

@ApiTags('reward-fulfilment')
@ApiBearerAuth('access-token')
@Controller('rewards/redemptions')
export class RewardFulfilmentController {
  constructor(private readonly service: PlayerRewardsService) {}

  @RequirePermissions(PERMISSION_CODES.REWARDS_MANAGE)
  @Post(':id/fulfill')
  fulfill(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: FulfillRedemptionDto,
  ) {
    return this.service.fulfill(id, input);
  }
}
