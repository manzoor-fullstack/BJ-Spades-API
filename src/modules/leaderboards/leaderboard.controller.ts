import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/decorators/public.decorator';
import { CurrentPlayer } from '../player-auth/decorators/current-player.decorator';
import { PlayerJwtGuard } from '../player-auth/guards/player-jwt.guard';
import type { AuthenticatedPlayer } from '../player-auth/interfaces/player-jwt-payload.interface';
import { LeaderboardQueryDto } from './dto/leaderboard-query.dto';
import { LeaderboardService } from './leaderboard.service';

@ApiTags('player-leaderboards')
@Public()
@UseGuards(PlayerJwtGuard)
@Controller('player/v1')
export class LeaderboardController {
  constructor(private readonly service: LeaderboardService) {}

  @Get('leaderboards')
  leaderboard(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Query() query: LeaderboardQueryDto,
  ) {
    return this.service.leaderboard(player.id, query);
  }

  @Get('leaderboards/me')
  me(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Query() query: LeaderboardQueryDto,
  ) {
    return this.service.me(player.id, query);
  }
}
