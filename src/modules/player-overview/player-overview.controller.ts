import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/decorators/public.decorator';
import { CurrentPlayer } from '../player-auth/decorators/current-player.decorator';
import { PlayerJwtGuard } from '../player-auth/guards/player-jwt.guard';
import type { AuthenticatedPlayer } from '../player-auth/interfaces/player-jwt-payload.interface';
import { PlayerOverviewService } from './player-overview.service';

@ApiTags('player-overview')
@Public()
@UseGuards(PlayerJwtGuard)
@Controller('player/v1/me')
export class PlayerOverviewController {
  constructor(private readonly service: PlayerOverviewService) {}

  @Get('overview')
  overview(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.overview(player.id);
  }

  @Get('stats')
  stats(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.stats(player.id);
  }

  @Get('achievements')
  achievements(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.achievements(player.id);
  }
}
