import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PlayerAuthProvider,
  PlayerEmailTokenPurpose,
  Prisma,
  UserStatus,
} from '@prisma/client';
import ms, { type StringValue } from 'ms';
import { createHash } from 'node:crypto';

import { hashToken, randomHex } from '../../common/crypto/token-hash.util';
import type { RequestContext } from '../../common/http/request-context.util';
import { PasswordService } from '../../common/password/password.service';
import type { LoginPlayerDto } from './dto/login-player.dto';
import type { PlayerSignupDto } from './dto/register-player.dto';
import type { PlayerJwtPayload } from './interfaces/player-jwt-payload.interface';
import {
  PlayerAuthRepository,
  type PlayerWithCredential,
} from './repositories/player-auth.repository';
import { PlayerEmailService } from './services/player-email.service';
import {
  PLAYER_OAUTH_GATEWAY,
  type PlayerOAuthGateway,
  type PlayerOAuthProfile,
} from './services/player-oauth.gateway';
import { PlayerTokenService } from './services/player-token.service';

const INVALID_CREDENTIALS = 'Invalid email or password.';
const REGISTRATION_MESSAGE =
  'If this address can be registered, a verification link has been sent.';
const RESET_MESSAGE =
  'If an eligible account exists, a password reset link has been sent.';
const REFRESH_REUSE_GRACE_MS = 5_000;

export interface PlayerView {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  tier: string;
  emailVerified: boolean;
  displayName: string;
  avatarName: string;
  avatarBackground: string;
  avatarUrl: string | null;
}

export interface PlayerSessionResult {
  user: PlayerView;
  rememberMe: boolean;
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
  csrfToken: string;
}

@Injectable()
export class PlayerAuthService implements OnModuleInit {
  private dummyHash = '';

  constructor(
    private readonly repository: PlayerAuthRepository,
    private readonly passwords: PasswordService,
    private readonly tokens: PlayerTokenService,
    private readonly email: PlayerEmailService,
    private readonly config: ConfigService,
    @Inject(PLAYER_OAUTH_GATEWAY)
    private readonly oauth: PlayerOAuthGateway,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dummyHash = await this.passwords.hash(randomHex(16));
  }

  async register(dto: PlayerSignupDto): Promise<{ message: string }> {
    const email = dto.email.trim().toLowerCase();
    const username = dto.username.trim().toLowerCase();

    if (await this.repository.findByUsername(username)) {
      throw new ConflictException('That username is unavailable.');
    }

    const existing = await this.repository.findByEmail(email);
    if (
      existing?.credential ||
      existing?.status === UserStatus.DELETED ||
      existing?.status === UserStatus.SUSPENDED
    ) {
      if (existing?.credential && !existing.emailVerified) {
        await this.sendVerification(existing);
      }
      return { message: REGISTRATION_MESSAGE };
    }

    const passwordHash = await this.passwords.hash(dto.password);
    let user: PlayerWithCredential;

    try {
      user = await this.repository.attachCredential({
        email,
        username,
        passwordHash,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('That username is unavailable.');
      }
      throw error;
    }

    await this.sendVerification(user);
    return { message: REGISTRATION_MESSAGE };
  }

  async verifyEmail(token: string): Promise<{ message: string }> {
    const user = await this.repository.verifyEmail(hashToken(token));
    if (!user) {
      throw new UnauthorizedException(
        'This verification link is invalid or has expired.',
      );
    }

    return { message: 'Email verified. You can now sign in.' };
  }

  async login(
    dto: LoginPlayerDto,
    context: RequestContext,
  ): Promise<PlayerSessionResult> {
    const user = await this.repository.findByEmail(
      dto.email.trim().toLowerCase(),
    );
    const storedHash = user?.credential?.passwordHash;

    if (!storedHash) {
      await this.passwords.compare(dto.password, this.dummyHash);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (!(await this.passwords.compare(dto.password, storedHash))) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (!user.emailVerified) {
      throw new ForbiddenException('Verify your email before signing in.');
    }
    if (
      user.status !== UserStatus.ACTIVE ||
      user.deletedAt ||
      !user.credential
    ) {
      throw new UnauthorizedException('This account is not available.');
    }

    const rememberMe = dto.rememberMe ?? false;
    const session = await this.repository.createSession({
      userId: user.id,
      rememberMe,
      expiresAt: new Date(
        Date.now() +
          ms(
            this.config.getOrThrow<StringValue>('playerAuth.sessionExpiresIn'),
          ),
      ),
      context,
    });

    return this.issueNewSession(user, session.id, rememberMe, context);
  }

  async beginOAuth(input: {
    provider: PlayerAuthProvider;
    rememberMe: boolean;
    redirectPath?: string;
  }): Promise<string> {
    const state = randomHex(32);
    const codeVerifier = randomHex(32);
    const redirectPath = this.safeRedirectPath(input.redirectPath);
    await this.repository.createOAuthState({
      stateHash: hashToken(state),
      provider: input.provider,
      codeVerifier,
      rememberMe: input.rememberMe,
      redirectPath,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    return this.oauth.authorizationUrl({
      provider: input.provider,
      state,
      codeChallenge: createHash('sha256')
        .update(codeVerifier)
        .digest('base64url'),
      callbackUrl: this.oauthCallbackUrl(input.provider),
    });
  }

  async completeOAuth(input: {
    provider: PlayerAuthProvider;
    state: string;
    code: string;
    context: RequestContext;
  }): Promise<PlayerSessionResult & { redirectPath: string }> {
    const oauthState = await this.repository.consumeOAuthState(
      hashToken(input.state),
      input.provider,
    );
    if (!oauthState) {
      throw new UnauthorizedException(
        'This sign-in request is invalid or expired.',
      );
    }
    const profile = await this.oauth.exchange({
      provider: input.provider,
      code: input.code,
      codeVerifier: oauthState.codeVerifier,
      callbackUrl: this.oauthCallbackUrl(input.provider),
    });
    if (
      profile.provider !== input.provider ||
      !profile.emailVerified ||
      !profile.email
    ) {
      throw new ForbiddenException('A verified provider email is required.');
    }

    const email = profile.email.trim().toLowerCase();
    const existing = await this.repository.findByEmail(email);
    if (
      existing?.status === UserStatus.SUSPENDED ||
      existing?.status === UserStatus.DELETED ||
      existing?.deletedAt
    ) {
      throw new UnauthorizedException('This account is not available.');
    }

    const user = await this.linkOAuthWithUniqueUsername(profile, email);
    if (
      user.status !== UserStatus.ACTIVE ||
      user.deletedAt ||
      !user.emailVerified ||
      !user.credential
    ) {
      throw new UnauthorizedException('This account is not available.');
    }
    const session = await this.repository.createSession({
      userId: user.id,
      rememberMe: oauthState.rememberMe,
      expiresAt: new Date(
        Date.now() +
          ms(
            this.config.getOrThrow<StringValue>('playerAuth.sessionExpiresIn'),
          ),
      ),
      context: input.context,
    });
    return {
      ...(await this.issueNewSession(
        user,
        session.id,
        oauthState.rememberMe,
        input.context,
      )),
      redirectPath: oauthState.redirectPath,
    };
  }

  async abandonOAuth(
    provider: PlayerAuthProvider,
    state: string | undefined,
  ): Promise<void> {
    if (state) {
      await this.repository.consumeOAuthState(hashToken(state), provider);
    }
  }

  playerAppRedirect(path: string, status: 'success' | 'error'): string {
    const appUrl = this.config.getOrThrow<string>('playerAuth.appUrl');
    const url = new URL(this.safeRedirectPath(path), appUrl);
    url.searchParams.set('oauth', status);
    return url.toString();
  }

  async refresh(
    refreshToken: string | undefined,
    context: RequestContext,
  ): Promise<PlayerSessionResult> {
    if (!refreshToken) {
      throw new UnauthorizedException('Your session has ended.');
    }

    let payload: PlayerJwtPayload;
    try {
      payload = await this.tokens.verifyRefresh(refreshToken);
    } catch {
      throw new UnauthorizedException('Your session has ended.');
    }

    const stored = await this.repository.findRefreshToken(
      hashToken(refreshToken),
    );
    if (!stored) throw new UnauthorizedException('Your session has ended.');

    if (stored.revokedAt) {
      const concurrentRotation =
        stored.replacedByTokenId !== null &&
        Date.now() - stored.revokedAt.getTime() <= REFRESH_REUSE_GRACE_MS;
      if (concurrentRotation) {
        throw new UnauthorizedException(
          'This refresh token has already been rotated.',
        );
      }
      await this.repository.revokeSession(stored.sessionId);
      throw new UnauthorizedException(
        'This session was ended because a refresh token was reused.',
      );
    }

    const { session } = stored;
    const user = session.user;
    if (
      stored.expiresAt.getTime() <= Date.now() ||
      !session.isActive ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now() ||
      payload.type !== 'player' ||
      payload.sid !== session.id ||
      payload.sub !== user.id ||
      user.status !== UserStatus.ACTIVE ||
      user.deletedAt ||
      !user.emailVerified ||
      !user.credential
    ) {
      await this.repository.revokeSession(session.id);
      throw new UnauthorizedException('Your session has ended.');
    }

    const tokenPair = await this.generatePair(user, session.id);
    const rotated = await this.repository.rotateRefreshToken({
      currentTokenId: stored.id,
      next: {
        tokenHash: hashToken(tokenPair.refreshToken),
        sessionId: session.id,
        userId: user.id,
        expiresAt: tokenPair.refreshExpiresAt,
        createdByIp: context.ipAddress,
      },
    });
    if (!rotated) {
      throw new UnauthorizedException(
        'This refresh token has already been rotated.',
      );
    }

    return {
      user: this.toView(user),
      rememberMe: session.rememberMe,
      ...tokenPair,
      csrfToken: randomHex(32),
    };
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;

    try {
      await this.tokens.verifyRefresh(refreshToken);
      const stored = await this.repository.findRefreshToken(
        hashToken(refreshToken),
      );
      if (stored) await this.repository.revokeSession(stored.sessionId);
    } catch {
      // Logout is idempotent. Invalid/expired cookies are cleared by the
      // controller without revealing whether a session once existed.
    }
  }

  async me(userId: string): Promise<PlayerView> {
    const user = await this.repository.findById(userId);
    if (!user?.credential) {
      throw new UnauthorizedException('Your session has ended.');
    }
    return this.toView(user);
  }

  async requestPasswordReset(emailValue: string): Promise<{ message: string }> {
    const user = await this.repository.findByEmail(
      emailValue.trim().toLowerCase(),
    );
    if (
      user?.credential?.passwordHash &&
      user.emailVerified &&
      user.status === UserStatus.ACTIVE &&
      !user.deletedAt
    ) {
      const token = randomHex(32);
      await this.repository.createEmailToken({
        userId: user.id,
        purpose: PlayerEmailTokenPurpose.PASSWORD_RESET,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 30 * 60_000),
      });
      await this.email.passwordReset(user.email, token);
    }

    return { message: RESET_MESSAGE };
  }

  async resetPassword(
    token: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    const passwordHash = await this.passwords.hash(newPassword);
    const changed = await this.repository.resetPassword(
      hashToken(token),
      passwordHash,
    );
    if (!changed) {
      throw new UnauthorizedException(
        'This password reset link is invalid or has expired.',
      );
    }

    return { message: 'Password changed. Sign in with your new password.' };
  }

  private async sendVerification(user: PlayerWithCredential): Promise<void> {
    const token = randomHex(32);
    await this.repository.createEmailToken({
      userId: user.id,
      purpose: PlayerEmailTokenPurpose.VERIFY_EMAIL,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    });
    await this.email.verification(user.email, token);
  }

  private async linkOAuthWithUniqueUsername(
    profile: PlayerOAuthProfile,
    email: string,
  ): Promise<PlayerWithCredential> {
    const root = (profile.username || email.split('@')[0] || 'player')
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 18);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const suffix = attempt === 0 ? '' : `_${randomHex(3)}`;
      const username = `${root || 'player'}${suffix}`.slice(0, 24);
      try {
        return await this.repository.linkOAuthProfile({
          provider: profile.provider,
          providerUserId: profile.providerUserId,
          email,
          username,
          firstName: profile.firstName?.trim() || root || 'Player',
          lastName: profile.lastName?.trim() || '',
        });
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== 'P2002'
        ) {
          throw error;
        }
      }
    }
    throw new ConflictException('Unable to create a unique player name.');
  }

  private oauthCallbackUrl(provider: PlayerAuthProvider): string {
    const publicUrl = this.config.getOrThrow<string>('app.publicUrl');
    return `${publicUrl.replace(/\/$/, '')}/api/player/v1/auth/oauth/${provider.toLowerCase()}/callback`;
  }

  private safeRedirectPath(value: string | undefined): string {
    if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
    try {
      const parsed = new URL(value, 'https://player.invalid');
      return parsed.origin === 'https://player.invalid'
        ? `${parsed.pathname}${parsed.search}${parsed.hash}`
        : '/';
    } catch {
      return '/';
    }
  }

  private async issueNewSession(
    user: PlayerWithCredential,
    sessionId: string,
    rememberMe: boolean,
    context: RequestContext,
  ): Promise<PlayerSessionResult> {
    const pair = await this.generatePair(user, sessionId);
    await this.repository.storeRefreshToken({
      tokenHash: hashToken(pair.refreshToken),
      sessionId,
      userId: user.id,
      expiresAt: pair.refreshExpiresAt,
      createdByIp: context.ipAddress,
    });
    return {
      user: this.toView(user),
      rememberMe,
      ...pair,
      csrfToken: randomHex(32),
    };
  }

  private async generatePair(user: PlayerWithCredential, sessionId: string) {
    const payload: PlayerJwtPayload = {
      sub: user.id,
      sid: sessionId,
      email: user.email,
      type: 'player',
    };
    const [access, refresh] = await Promise.all([
      this.tokens.access(payload),
      this.tokens.refresh(payload),
    ]);
    return {
      accessToken: access.token,
      accessExpiresAt: access.expiresAt,
      refreshToken: refresh.token,
      refreshExpiresAt: refresh.expiresAt,
    };
  }

  private toView(user: PlayerWithCredential): PlayerView {
    if (!user.credential) {
      throw new UnauthorizedException('Your session has ended.');
    }
    return {
      id: user.id,
      username: user.credential.username,
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: `${user.firstName} ${user.lastName}`.trim(),
      email: user.email,
      tier: user.tier,
      emailVerified: user.emailVerified,
      displayName:
        user.playerProfile?.displayName ??
        `${user.firstName} ${user.lastName}`.trim(),
      avatarName: user.playerProfile?.avatarName ?? 'Poppa Cool',
      avatarBackground: user.playerProfile?.avatarBackground ?? '#fbbf24',
      avatarUrl: user.playerProfile?.avatarImage?.url ?? null,
    };
  }
}
