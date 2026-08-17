import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ActivityCategory } from '@prisma/client';
import type { Request } from 'express';

import { ACTIVITY_ACTIONS } from '../../common/constants/activity-actions';
import { AuditLog } from '../../common/decorators/audit-log.decorator';
import { extractRequestContext } from '../../common/http/request-context.util';
import type { ValidatableUpload } from '../storage/image-validation';
import { ImageUploadInterceptor } from '../storage/image-upload.interceptor';

import { AuthService } from './auth.service';
import { CurrentAdmin } from './decorators/current-admin.decorator';
import { Public } from './decorators/public.decorator';
import { AuthResponseDto, AuthTokensDto } from './dto/login-response.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import type { AuthenticatedAdmin } from './interfaces/authenticated-admin.interface';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  // Tighter than the global limit: login is the one endpoint worth
  // brute-forcing. 5 attempts per minute per IP.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in and start a session' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @ApiResponse({ status: 429, description: 'Too many attempts' })
  login(@Body() loginDto: LoginDto, @Req() request: Request) {
    return this.authService.login(loginDto, extractRequestContext(request));
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new token pair',
    description:
      'Rotates the refresh token. Presenting an already-used token revokes the entire session.',
  })
  @ApiResponse({ status: 200, type: AuthTokensDto })
  @ApiResponse({
    status: 401,
    description: 'Invalid, expired, or reused token',
  })
  refresh(@Body() dto: RefreshTokenDto, @Req() request: Request) {
    return this.authService.refresh(
      dto.refreshToken,
      extractRequestContext(request),
    );
  }

  @ApiBearerAuth('access-token')
  @AuditLog({
    category: ActivityCategory.AUTH,
    action: ACTIVITY_ACTIONS.AUTH_LOGOUT.code,
    title: (ctx) => `${ctx.admin?.email ?? 'An admin'} signed out`,
    entityType: 'Admin',
    entityId: (ctx) => ctx.admin?.id,
  })
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'End the current session' })
  @ApiResponse({ status: 204, description: 'Session revoked' })
  async logout(@CurrentAdmin() admin: AuthenticatedAdmin): Promise<void> {
    await this.authService.logout(admin.sessionId);
  }

  @ApiBearerAuth('access-token')
  @AuditLog({
    category: ActivityCategory.AUTH,
    action: ACTIVITY_ACTIONS.AUTH_LOGOUT_ALL.code,
    title: (ctx) =>
      `${ctx.admin?.email ?? 'An admin'} signed out of all other sessions`,
    entityType: 'Admin',
    entityId: (ctx) => ctx.admin?.id,
  })
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'End every other session',
    description: 'Revokes all sessions for this admin except the current one.',
  })
  async logoutAll(@CurrentAdmin() admin: AuthenticatedAdmin): Promise<void> {
    await this.authService.logoutAll(admin.id, admin.sessionId);
  }

  @ApiBearerAuth('access-token')
  @Get('me')
  @ApiOperation({ summary: 'Current admin profile with live permissions' })
  me(@CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.authService.me(admin.id);
  }

  @ApiBearerAuth('access-token')
  @Patch('me')
  @UseInterceptors(ImageUploadInterceptor('image'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Update your own profile',
    description:
      'Self-service: no permission code required. The admin edited is always the caller.',
  })
  @ApiResponse({ status: 200, description: 'The updated profile' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  updateMe(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body() dto: UpdateProfileDto,
    @UploadedFile() image: ValidatableUpload | undefined,
  ) {
    return this.authService.updateProfile(admin.id, dto, image);
  }
}
