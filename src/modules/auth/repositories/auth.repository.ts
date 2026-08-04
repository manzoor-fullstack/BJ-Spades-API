import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

export interface CreateSessionData {
  adminId: string;
  expiresAt: Date;
  device?: string;
  browser?: string;
  os?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface CreateRefreshTokenData {
  tokenHash: string;
  sessionId: string;
  adminId: string;
  expiresAt: Date;
  createdByIp?: string;
}

const ROLE_WITH_PERMISSIONS = {
  role: {
    include: {
      permissions: {
        include: {
          permission: true,
        },
      },
    },
  },
} as const;

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Admin lookups ───────────────────────────────────────────

  async findAdminByEmail(email: string) {
    return this.prisma.admin.findUnique({
      where: { email },
      include: ROLE_WITH_PERMISSIONS,
    });
  }

  async findAdminById(id: string) {
    return this.prisma.admin.findUnique({
      where: { id },
      include: { role: true },
    });
  }

  async getAdminProfile(id: string) {
    return this.prisma.admin.findUnique({
      where: { id },
      include: ROLE_WITH_PERMISSIONS,
    });
  }

  /**
   * Flat list of permission codes granted to an admin through their role.
   *
   * Deliberately narrower than getAdminProfile: PermissionsGuard runs on every
   * protected request and needs codes, not the whole profile graph.
   */
  async findPermissionCodesForAdmin(adminId: string): Promise<string[]> {
    const rows = await this.prisma.rolePermission.findMany({
      where: { role: { admins: { some: { id: adminId } } } },
      select: { permission: { select: { code: true } } },
    });

    return rows.map((row) => row.permission.code);
  }

  async updateLastLogin(adminId: string) {
    return this.prisma.admin.update({
      where: { id: adminId },
      data: { lastLogin: new Date() },
    });
  }

  // ─── Sessions ────────────────────────────────────────────────

  async createSession(data: CreateSessionData) {
    return this.prisma.session.create({ data });
  }

  async findSessionById(sessionId: string) {
    return this.prisma.session.findUnique({ where: { id: sessionId } });
  }

  /**
   * Loads the session together with its admin and role in a single query.
   *
   * Used on every authenticated request. The previous code already made one
   * round trip (findAdminById), so validating the session costs nothing extra
   * and buys immediate revocation: revoking a session stops its access token
   * working on the very next request rather than up to 15 minutes later.
   */
  async findSessionWithAdmin(sessionId: string) {
    return this.prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        admin: {
          include: { role: true },
        },
      },
    });
  }

  async findActiveSessionsForAdmin(adminId: string) {
    return this.prisma.session.findMany({
      where: { adminId, isActive: true, revokedAt: null },
      orderBy: { lastActivity: 'desc' },
    });
  }

  async touchSession(sessionId: string) {
    return this.prisma.session.update({
      where: { id: sessionId },
      data: { lastActivity: new Date() },
    });
  }

  /**
   * Revokes a session and every refresh token in its rotation chain, in one
   * transaction. A session revoked without its tokens would still be
   * refreshable, which defeats the point.
   */
  async revokeSession(sessionId: string, revokedBy?: string) {
    const now = new Date();

    return this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: { sessionId, revokedAt: null },
        data: { revokedAt: now },
      }),
      this.prisma.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: now, isActive: false, revokedBy: revokedBy ?? null },
      }),
    ]);
  }

  /** Revokes every session for an admin, optionally sparing the current one. */
  async revokeAllSessionsForAdmin(adminId: string, exceptSessionId?: string) {
    const now = new Date();

    return this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: {
          adminId,
          revokedAt: null,
          ...(exceptSessionId ? { sessionId: { not: exceptSessionId } } : {}),
        },
        data: { revokedAt: now },
      }),
      this.prisma.session.updateMany({
        where: {
          adminId,
          revokedAt: null,
          ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
        },
        data: { revokedAt: now, isActive: false, revokedBy: adminId },
      }),
    ]);
  }

  // ─── Refresh tokens ──────────────────────────────────────────

  async createRefreshToken(data: CreateRefreshTokenData) {
    return this.prisma.refreshToken.create({ data });
  }

  async findRefreshTokenByHash(tokenHash: string) {
    return this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { session: true },
    });
  }

  /**
   * Atomically revokes the presented token and issues its replacement.
   *
   * Both happen in one transaction so a crash between them cannot leave a
   * session with no usable token, or two live tokens at once.
   */
  async rotateRefreshToken(params: {
    currentTokenId: string;
    next: CreateRefreshTokenData;
  }) {
    const { currentTokenId, next } = params;

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.refreshToken.create({ data: next });

      await tx.refreshToken.update({
        where: { id: currentTokenId },
        data: { revokedAt: new Date(), replacedByTokenId: created.id },
      });

      await tx.session.update({
        where: { id: next.sessionId },
        data: { lastActivity: new Date() },
      });

      return created;
    });
  }

  /** Housekeeping: drop tokens that expired more than `olderThanDays` ago. */
  async deleteExpiredRefreshTokens(olderThanDays = 30) {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

    return this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: cutoff } },
    });
  }
}
