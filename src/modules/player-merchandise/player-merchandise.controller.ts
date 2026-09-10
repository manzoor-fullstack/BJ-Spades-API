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
import { ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/decorators/public.decorator';
import { CurrentPlayer } from '../player-auth/decorators/current-player.decorator';
import { PlayerCsrfGuard } from '../player-auth/guards/player-csrf.guard';
import { PlayerJwtGuard } from '../player-auth/guards/player-jwt.guard';
import type { AuthenticatedPlayer } from '../player-auth/interfaces/player-jwt-payload.interface';
import { CreateMerchandiseClaimDto } from './dto/create-merchandise-claim.dto';
import { PlayerMerchandiseService } from './player-merchandise.service';

@ApiTags('player-merchandise')
@Public()
@UseGuards(PlayerJwtGuard)
@Controller('player/v1')
export class PlayerMerchandiseController {
  constructor(private readonly service: PlayerMerchandiseService) {}

  @Get('merchandise')
  catalog() {
    return this.service.catalog();
  }

  @Get('me/shipments')
  list(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.list(player.id);
  }

  @Post('me/shipments')
  @UseGuards(PlayerCsrfGuard)
  create(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Body() dto: CreateMerchandiseClaimDto,
  ) {
    return this.service.create(player.id, dto);
  }

  @Post('me/shipments/:id/cancel')
  @UseGuards(PlayerCsrfGuard)
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.cancel(player.id, id);
  }
}
