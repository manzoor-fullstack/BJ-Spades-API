import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/decorators/public.decorator';
import { CurrentPlayer } from '../player-auth/decorators/current-player.decorator';
import { PlayerCsrfGuard } from '../player-auth/guards/player-csrf.guard';
import { PlayerJwtGuard } from '../player-auth/guards/player-jwt.guard';
import type { AuthenticatedPlayer } from '../player-auth/interfaces/player-jwt-payload.interface';
import { CreateMatchDto } from './dto/create-match.dto';
import { SubmitGameCommandDto } from './dto/submit-game-command.dto';
import { MatchesService } from './matches.service';

@ApiTags('player-matches')
@Public()
@UseGuards(PlayerJwtGuard)
@Controller('player/v1/matches')
export class MatchesController {
  constructor(private readonly service: MatchesService) {}

  @Get()
  list(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.list(player.id);
  }

  @Post()
  @UseGuards(PlayerCsrfGuard)
  create(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Body() input: CreateMatchDto,
  ) {
    return this.service.create(player.id, input);
  }

  @Post(':id/join')
  @UseGuards(PlayerCsrfGuard)
  join(@CurrentPlayer() player: AuthenticatedPlayer, @Param('id') id: string) {
    return this.service.join(player.id, id);
  }

  @Get(':id')
  get(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id') id: string,
    @Headers('x-game-entry-token') entryToken: string | undefined,
  ) {
    return this.service.get(player.id, id, entryToken);
  }

  @Post(':id/reveal-hand')
  @UseGuards(PlayerCsrfGuard)
  revealHand(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id') id: string,
    @Headers('x-game-entry-token') entryToken: string | undefined,
  ) {
    return this.service.revealHand(player.id, id, entryToken);
  }

  @Get(':id/events')
  events(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id') id: string,
    @Headers('x-game-entry-token') entryToken: string | undefined,
    @Query('after', new DefaultValuePipe(0), ParseIntPipe) after: number,
  ) {
    return this.service.events(player.id, id, entryToken, after);
  }

  @Post(':id/commands')
  @UseGuards(PlayerCsrfGuard)
  command(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id') id: string,
    @Headers('x-game-entry-token') entryToken: string | undefined,
    @Body() input: SubmitGameCommandDto,
  ) {
    return this.service.command(player.id, id, entryToken, input);
  }
}
