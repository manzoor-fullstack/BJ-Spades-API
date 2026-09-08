import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/decorators/public.decorator';
import { CurrentPlayer } from '../player-auth/decorators/current-player.decorator';
import { PlayerCsrfGuard } from '../player-auth/guards/player-csrf.guard';
import { PlayerJwtGuard } from '../player-auth/guards/player-jwt.guard';
import type { AuthenticatedPlayer } from '../player-auth/interfaces/player-jwt-payload.interface';
import { CreateChallengeDto } from './dto/create-challenge.dto';
import { CreateFriendRequestDto } from './dto/create-friend-request.dto';
import { PlayerSocialService } from './player-social.service';

@ApiTags('player-social')
@Public()
@UseGuards(PlayerJwtGuard, PlayerCsrfGuard)
@Controller('player/v1')
export class PlayerSocialController {
  constructor(private readonly service: PlayerSocialService) {}

  @Get('me/friends')
  friends(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.listFriends(player.id);
  }

  @Post('me/presence/heartbeat')
  heartbeat(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.heartbeat(player.id);
  }

  @Post('me/friend-requests')
  requestFriend(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Body() dto: CreateFriendRequestDto,
  ) {
    return this.service.requestFriend(player.id, dto.playerId);
  }

  @Get('me/friend-requests')
  friendRequests(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.listFriendRequests(player.id);
  }

  @Post('me/friend-requests/:id/accept')
  acceptFriend(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id') id: string,
  ) {
    return this.service.respondToFriend(player.id, id, true);
  }

  @Post('me/friend-requests/:id/decline')
  declineFriend(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id') id: string,
  ) {
    return this.service.respondToFriend(player.id, id, false);
  }

  @Delete('me/friends/:playerId')
  removeFriend(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('playerId') friendId: string,
  ) {
    return this.service.removeFriend(player.id, friendId);
  }

  @Post('me/blocks/:playerId')
  block(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('playerId') blockedId: string,
  ) {
    return this.service.block(player.id, blockedId);
  }

  @Delete('me/blocks/:playerId')
  unblock(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('playerId') blockedId: string,
  ) {
    return this.service.unblock(player.id, blockedId);
  }

  @Post('challenges')
  challenge(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Body() dto: CreateChallengeDto,
  ) {
    return this.service.createChallenge(player.id, dto);
  }

  @Get('challenges/:id')
  challengeStatus(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id') id: string,
  ) {
    return this.service.getChallenge(player.id, id);
  }

  @Post('challenges/:id/accept')
  acceptChallenge(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id') id: string,
  ) {
    return this.service.acceptChallenge(player.id, id);
  }

  @Post('challenges/:id/decline')
  declineChallenge(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id') id: string,
  ) {
    return this.service.resolveChallenge(player.id, id, 'DECLINED');
  }

  @Post('challenges/:id/cancel')
  cancelChallenge(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id') id: string,
  ) {
    return this.service.resolveChallenge(player.id, id, 'CANCELLED');
  }
}
