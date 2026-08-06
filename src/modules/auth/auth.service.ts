import {
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActivityCategory } from '@prisma/client';
import ms, { StringValue } from 'ms';

import { ACTIVITY_ACTIONS } from '../../common/constants/activity-actions';
import { hashToken, randomHex } from '../../common/crypto/token-hash.util';
import { RequestContext } from '../../common/http/request-context.util';
import { PasswordService } from '../../common/password/password.service';
import { ActivityLogService } from '../activity/activity.service';
import { SettingsService } from '../settings/settings.service';

import { AuthResponseDto, AuthTokensDto } from './dto/login-response.dto';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { AuthRepository } from './repositories/auth.repository';
import { TokenService } from './services/token.service';

/** Deliberately identical for unknown email and wrong password. */
const INVALID_CREDENTIALS = 'Invalid email or password.';

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  /**
   * A throwaway bcrypt hash compared against when the email is unknown, so a
   * missing account costs the same time as a wrong password. Without it, the
   * response-time difference lets an attacker enumerate valid admin addresses.
   */
  private dummyHash = '';

  constructor(
    private readonly authRepository: AuthRepository,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly configService: ConfigService,
    private readonly activityLog: ActivityLogService,
    private readonly settings: SettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dummyHash = await this.passwordService.hash(randomHex(16));
  }

  // ─── Login ───────────────────────────────────────────────────

  async login(
    loginDto: LoginDto,
    context: RequestContext = {},
  ): Promise<AuthResponseDto> {
    const { email, password } = loginDto;
    const attemptedEmail = email.toLowerCase().trim();

    const admin = await this.authRepository.findAdminByEmail(attemptedEmail);

    if (!admin) {
      // Burn equivalent time before failing.
      await this.passwordService.compare(password, this.dummyHash);
      await this.recordFailedLogin(attemptedEmail, 'Unknown email', context);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const passwordMatches = await this.passwordService.compare(
      password,
      admin.password,
    );

    if (!passwordMatches) {
      await this.recordFailedLogin(attemptedEmail, 'Wrong password', context);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    // Checked after the password so a deactivated account cannot be
    // distinguished from a wrong password without valid credentials.
    if (!admin.isActive) {
      await this.recordFailedLogin(
        attemptedEmail,
        'Account deactivated',
        context,
      );
      throw new UnauthorizedException('Your account has been deactivated.');
    }

    const session = await this.authRepository.createSession({
      adminId: admin.id,
      expiresAt: await this.sessionExpiryDate(),
      device: context.device,
      browser: context.browser,
      os: context.os,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    const tokens = await this.issueTokens(
      {
        sub: admin.id,
        email: admin.email,
        role: admin.role.name,
        roleId: admin.role.id,
        sid: session.id,
      },
      context.ipAddress,
    );

    await this.authRepository.updateLastLogin(admin.id);

    // Logged here rather than by AuditInterceptor: /auth/login is @Public(),
    // so there is no admin on the request for the interceptor to attribute.
    await this.activityLog.record({
      category: ActivityCategory.AUTH,
      action: ACTIVITY_ACTIONS.AUTH_LOGIN.code,
      title: `${admin.email} signed in`,
      description: context.browser
        ? `${context.browser} on ${context.os ?? 'an unknown OS'}`
        : null,
      adminId: admin.id,
      entityType: 'Admin',
      entityId: admin.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { sessionId: session.id, device: context.device },
    });

    return {
      ...tokens,
      admin: {
        id: admin.id,
        firstName: admin.firstName,
        lastName: admin.lastName,
        email: admin.email,
        role: admin.role.name,
        roleDisplayName: admin.role.displayName,
        permissions: admin.role.permissions.map((rp) => rp.permission.code),
      },
    };
  }

  // ─── Refresh ─────────────────────────────────────────────────

  async refresh(
    refreshToken: string,
    context: RequestContext = {},
  ): Promise<AuthTokensDto> {
    // Verify the signature first so a forged token never reaches the database.
    let payload: JwtPayload;

    try {
      payload = await this.tokenService.verifyRefreshToken(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }

    const stored = await this.authRepository.findRefreshTokenByHash(
      hashToken(refreshToken),
    );

    // Correctly signed but absent from the database: either already rotated
    // away and pruned, or minted with a leaked signing key.
    if (!stored) {
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }

    if (stored.revokedAt) {
      // Reuse of a rotated token means someone replayed a stolen copy. The
      // legitimate holder also holds a token in this chain, so the safe
      // response is to kill the whole session and force a fresh login.
      this.logger.warn(
        `Refresh token reuse detected for admin ${stored.adminId}; revoking session ${stored.sessionId}`,
      );

      await this.authRepository.revokeSession(stored.sessionId);

      // On the throwing path, so AuditInterceptor never sees it.
      await this.activityLog.record({
        category: ActivityCategory.AUTH,
        action: ACTIVITY_ACTIONS.AUTH_TOKEN_REUSE_DETECTED.code,
        title: 'Refresh token reuse detected',
        description: `A rotated refresh token was replayed; session ${stored.sessionId} was revoked.`,
        adminId: stored.adminId,
        entityType: 'Session',
        entityId: stored.sessionId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      });

      throw new UnauthorizedException(
        'This session has been ended for security reasons. Please sign in again.',
      );
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }

    if (!stored.session.isActive || stored.session.revokedAt) {
      throw new UnauthorizedException('This session is no longer active.');
    }

    if (payload.sid !== stored.sessionId) {
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }

    const admin = await this.authRepository.findAdminById(stored.adminId);

    if (!admin || !admin.isActive) {
      await this.authRepository.revokeSession(stored.sessionId);

      await this.activityLog.record({
        category: ActivityCategory.AUTH,
        action: ACTIVITY_ACTIONS.AUTH_SESSION_REVOKED.code,
        title: 'Session revoked',
        description:
          'A refresh was attempted for an admin that is no longer active.',
        adminId: stored.adminId,
        entityType: 'Session',
        entityId: stored.sessionId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      });

      throw new UnauthorizedException('Your account is no longer active.');
    }

    const nextPayload: JwtPayload = {
      sub: admin.id,
      email: admin.email,
      role: admin.role.name,
      roleId: admin.role.id,
      sid: stored.sessionId,
    };

    const accessToken =
      await this.tokenService.generateAccessToken(nextPayload);
    const nextRefresh =
      await this.tokenService.generateRefreshToken(nextPayload);

    await this.authRepository.rotateRefreshToken({
      currentTokenId: stored.id,
      next: {
        tokenHash: hashToken(nextRefresh.token),
        sessionId: stored.sessionId,
        adminId: admin.id,
        expiresAt: nextRefresh.expiresAt,
        createdByIp: context.ipAddress,
      },
    });

    return {
      accessToken,
      refreshToken: nextRefresh.token,
      expiresIn: this.accessExpiresInSeconds(),
    };
  }

  // ─── Logout ──────────────────────────────────────────────────

  async logout(sessionId: string): Promise<void> {
    await this.authRepository.revokeSession(sessionId);
  }

  /** Ends every other session, leaving the caller signed in. */
  async logoutAll(adminId: string, currentSessionId: string): Promise<void> {
    await this.authRepository.revokeAllSessionsForAdmin(
      adminId,
      currentSessionId,
    );
  }

  // ─── Profile ─────────────────────────────────────────────────

  async me(adminId: string) {
    const admin = await this.authRepository.getAdminProfile(adminId);

    if (!admin) {
      throw new UnauthorizedException('Admin not found.');
    }

    return {
      id: admin.id,
      firstName: admin.firstName,
      lastName: admin.lastName,
      fullName: `${admin.firstName} ${admin.lastName}`.trim(),
      email: admin.email,
      role: admin.role.name,
      roleDisplayName: admin.role.displayName,
      permissions: admin.role.permissions.map((rp) => rp.permission.code),
      isActive: admin.isActive,
      lastLogin: admin.lastLogin,
      createdAt: admin.createdAt,
    };
  }

  // ─── Internals ───────────────────────────────────────────────

  /**
   * A failed login has no authenticated admin, so `adminId` stays null and the
   * attempted address goes in the description — that is what makes the entry
   * useful when someone is walking a list of addresses.
   *
   * The attempted password is never recorded, not even hashed.
   */
  private async recordFailedLogin(
    attemptedEmail: string,
    reason: string,
    context: RequestContext,
  ): Promise<void> {
    await this.activityLog.record({
      category: ActivityCategory.AUTH,
      action: ACTIVITY_ACTIONS.AUTH_LOGIN_FAILED.code,
      title: 'Failed sign-in attempt',
      description: `Failed sign-in attempt for ${attemptedEmail}`,
      adminId: null,
      entityType: 'Admin',
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { email: attemptedEmail, reason },
    });
  }

  private async issueTokens(
    payload: JwtPayload,
    ipAddress?: string,
  ): Promise<AuthTokensDto> {
    const [accessToken, refresh] = await Promise.all([
      this.tokenService.generateAccessToken(payload),
      this.tokenService.generateRefreshToken(payload),
    ]);

    await this.authRepository.createRefreshToken({
      tokenHash: hashToken(refresh.token),
      sessionId: payload.sid,
      adminId: payload.sub,
      expiresAt: refresh.expiresAt,
      createdByIp: ipAddress,
    });

    return {
      accessToken,
      refreshToken: refresh.token,
      expiresIn: this.accessExpiresInSeconds(),
    };
  }

  /**
   * How long the session created by this login stays valid.
   *
   * Driven by the `security.sessionTimeoutMinutes` setting (Phase 7, D-10),
   * which is what makes that field a real control rather than a stored number:
   * `JwtStrategy` checks `Session.expiresAt` on every request, so shortening
   * the timeout genuinely shortens the next session.
   *
   * `jwt.refreshExpiresIn` still bounds the refresh token itself and is the
   * fallback if settings cannot be read — a login must not fail because the
   * settings table is unavailable.
   */
  private async sessionExpiryDate(): Promise<Date> {
    try {
      const minutes = await this.settings.getSessionTimeoutMinutes();

      return new Date(Date.now() + minutes * 60_000);
    } catch (error) {
      this.logger.warn(
        `Could not read the configured session timeout; falling back to jwt.refreshExpiresIn: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return this.refreshExpiryDate();
    }
  }

  private refreshExpiryDate(): Date {
    const expiresIn = this.configService.getOrThrow<StringValue>(
      'jwt.refreshExpiresIn',
    );

    return new Date(Date.now() + ms(expiresIn));
  }

  private accessExpiresInSeconds(): number {
    const expiresIn = this.configService.getOrThrow<StringValue>(
      'jwt.accessExpiresIn',
    );

    return Math.floor(ms(expiresIn) / 1000);
  }
}
