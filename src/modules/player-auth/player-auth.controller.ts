import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PlayerAuthProvider } from '@prisma/client';
import type { Request, Response } from 'express';

import { Public } from '../auth/decorators/public.decorator';
import { extractRequestContext } from '../../common/http/request-context.util';
import { CurrentPlayer } from './decorators/current-player.decorator';
import { EmailTokenDto } from './dto/email-token.dto';
import { LoginPlayerDto } from './dto/login-player.dto';
import { PlayerSignupDto } from './dto/register-player.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { PlayerCsrfGuard } from './guards/player-csrf.guard';
import { PlayerJwtGuard } from './guards/player-jwt.guard';
import { PlayerOriginGuard } from './guards/player-origin.guard';
import type { AuthenticatedPlayer } from './interfaces/player-jwt-payload.interface';
import {
  clearPlayerCookies,
  PLAYER_REFRESH_COOKIE,
  readCookie,
  writePlayerCookies,
} from './player-cookies';
import {
  PlayerAuthService,
  type PlayerSessionResult,
} from './player-auth.service';

@ApiTags('player-auth')
@Controller('player/v1/auth')
export class PlayerAuthController {
  constructor(
    private readonly service: PlayerAuthService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @UseGuards(PlayerOriginGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Register or claim a player account' })
  register(@Body() dto: PlayerSignupDto) {
    return this.service.register(dto);
  }

  @Public()
  @UseGuards(PlayerOriginGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  verifyEmail(@Body() dto: EmailTokenDto) {
    return this.service.verifyEmail(dto.token);
  }

  @Public()
  @UseGuards(PlayerOriginGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginPlayerDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.service.login(
      dto,
      extractRequestContext(request),
    );
    this.writeSession(response, result);
    return { user: result.user };
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('oauth/:provider/start')
  async startOAuth(
    @Param('provider') providerValue: string,
    @Query('rememberMe') rememberMe: string | undefined,
    @Query('redirect') redirectPath: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const provider = this.provider(providerValue);
    try {
      const authorizationUrl = await this.service.beginOAuth({
        provider,
        rememberMe: rememberMe === 'true',
        redirectPath,
      });
      response.redirect(authorizationUrl);
    } catch {
      response.redirect(this.service.playerAppRedirect('/', 'error'));
    }
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('oauth/:provider/callback')
  async completeOAuth(
    @Param('provider') providerValue: string,
    @Query('state') state: string | undefined,
    @Query('code') code: string | undefined,
    @Query('error') providerError: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const provider = this.provider(providerValue);
    try {
      if (!state || !code || providerError) {
        await this.service.abandonOAuth(provider, state);
        throw new Error('OAuth authorization was not completed');
      }
      const result = await this.service.completeOAuth({
        provider,
        state,
        code,
        context: extractRequestContext(request),
      });
      this.writeSession(response, result);
      response.redirect(
        this.service.playerAppRedirect(result.redirectPath, 'success'),
      );
    } catch {
      clearPlayerCookies(response, this.secureCookies());
      response.redirect(this.service.playerAppRedirect('/', 'error'));
    }
  }

  @Public()
  @UseGuards(PlayerCsrfGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.service.refresh(
      readCookie(request, PLAYER_REFRESH_COOKIE),
      extractRequestContext(request),
    );
    this.writeSession(response, result);
    return { user: result.user };
  }

  @Public()
  @UseGuards(PlayerCsrfGuard)
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.service.logout(readCookie(request, PLAYER_REFRESH_COOKIE));
    clearPlayerCookies(response, this.secureCookies());
  }

  @Public()
  @UseGuards(PlayerOriginGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('password/request')
  @HttpCode(HttpStatus.ACCEPTED)
  requestPasswordReset(@Body() dto: RequestPasswordResetDto) {
    return this.service.requestPasswordReset(dto.email);
  }

  @Public()
  @UseGuards(PlayerOriginGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('password/reset')
  @HttpCode(HttpStatus.OK)
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.service.resetPassword(dto.token, dto.newPassword);
  }

  private writeSession(response: Response, result: PlayerSessionResult): void {
    writePlayerCookies(
      response,
      result,
      result.rememberMe,
      this.secureCookies(),
    );
  }

  private secureCookies(): boolean {
    return this.config.get<string>('app.nodeEnv') === 'production';
  }

  private provider(value: string): PlayerAuthProvider {
    if (value.toLowerCase() === 'google') return PlayerAuthProvider.GOOGLE;
    if (value.toLowerCase() === 'github') return PlayerAuthProvider.GITHUB;
    throw new NotFoundException('OAuth provider not found.');
  }
}

@ApiTags('player')
@Public()
@UseGuards(PlayerJwtGuard)
@Controller('player/v1')
export class PlayerSessionController {
  constructor(private readonly service: PlayerAuthService) {}

  @Get('me')
  me(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.me(player.id);
  }
}
