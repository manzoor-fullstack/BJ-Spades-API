import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/decorators/public.decorator';
import { CurrentPlayer } from '../player-auth/decorators/current-player.decorator';
import { PlayerCsrfGuard } from '../player-auth/guards/player-csrf.guard';
import { PlayerJwtGuard } from '../player-auth/guards/player-jwt.guard';
import type { AuthenticatedPlayer } from '../player-auth/interfaces/player-jwt-payload.interface';
import { ImageUploadInterceptor } from '../storage/image-upload.interceptor';
import type { ValidatableUpload } from '../storage/image-validation';
import { UpdatePlayerProfileDto } from './dto/update-player-profile.dto';
import { PlayerProfileService } from './player-profile.service';

@ApiTags('player-profile')
@Public()
@UseGuards(PlayerJwtGuard, PlayerCsrfGuard)
@Controller('player/v1/me/profile')
export class PlayerProfileController {
  constructor(private readonly service: PlayerProfileService) {}

  @Get()
  get(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.get(player.id);
  }

  @Patch()
  update(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Body() dto: UpdatePlayerProfileDto,
  ) {
    return this.service.update(player.id, dto);
  }

  @Post('avatar')
  @UseInterceptors(ImageUploadInterceptor('image'))
  @ApiConsumes('multipart/form-data')
  uploadAvatar(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @UploadedFile() image: ValidatableUpload | undefined,
  ) {
    return this.service.uploadAvatar(player.id, image);
  }
}
