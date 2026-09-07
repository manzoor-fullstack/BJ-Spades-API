import { Injectable } from '@nestjs/common';
import {
  PlayerAuthProvider,
  PlayerEmailTokenPurpose,
  Prisma,
  UserSource,
  UserStatus,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';

const USER_WITH_CREDENTIAL = {
  credential: true,
} satisfies Prisma.UserInclude;

const REFRESH_WITH_SESSION = {
  session: {
    include: {
      user: { include: USER_WITH_CREDENTIAL },
    },
  },
} satisfies Prisma.PlayerRefreshTokenInclude;

export type PlayerWithCredential = Prisma.UserGetPayload<{
  include: typeof USER_WITH_CREDENTIAL;
}>;

export type StoredPlayerRefresh = Prisma.PlayerRefreshTokenGetPayload<{
  include: typeof REFRESH_WITH_SESSION;
}>;

export interface PlayerSessionContext {
  device?: string;
  browser?: string;
  os?: string;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class PlayerAuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string): Promise<PlayerWithCredential | null> {
    return this.prisma.user.findUnique({
      where: { email },
      include: USER_WITH_CREDENTIAL,
    });
  }

  findByUsername(username: string): Promise<PlayerWithCredential | null> {
    return this.prisma.user.findFirst({
      where: { credential: { is: { username } } },
      include: USER_WITH_CREDENTIAL,
    });
  }

  findById(id: string): Promise<PlayerWithCredential | null> {
    return this.prisma.user.findUnique({
      where: { id },
      include: USER_WITH_CREDENTIAL,
    });
  }

  createOAuthState(input: {
    stateHash: string;
    provider: PlayerAuthProvider;
    codeVerifier: string;
    rememberMe: boolean;
    redirectPath: string;
    expiresAt: Date;
  }) {
    return this.prisma.playerOAuthState.create({ data: input });
  }

  async consumeOAuthState(stateHash: string, provider: PlayerAuthProvider) {
    return this.prisma.$transaction(async (tx) => {
      const state = await tx.playerOAuthState.findUnique({
        where: { stateHash },
      });
      if (
        !state ||
        state.provider !== provider ||
        state.consumedAt ||
        state.expiresAt.getTime() <= Date.now()
      ) {
        return null;
      }
      const consumed = await tx.playerOAuthState.updateMany({
        where: {
          id: state.id,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });
      return consumed.count === 1 ? state : null;
    });
  }

  async linkOAuthProfile(input: {
    provider: PlayerAuthProvider;
    providerUserId: string;
    email: string;
    username: string;
    firstName: string;
    lastName: string;
  }): Promise<PlayerWithCredential> {
    return this.prisma.$transaction(async (tx) => {
      const linked = await tx.playerOAuthAccount.findUnique({
        where: {
          provider_providerUserId: {
            provider: input.provider,
            providerUserId: input.providerUserId,
          },
        },
      });
      if (linked) {
        return tx.user.findUniqueOrThrow({
          where: { id: linked.userId },
          include: USER_WITH_CREDENTIAL,
        });
      }

      let user = await tx.user.findUnique({ where: { email: input.email } });
      if (!user) {
        user = await tx.user.create({
          data: {
            firstName: input.firstName,
            lastName: input.lastName,
            email: input.email,
            source: UserSource.PLAYER,
            status: UserStatus.ACTIVE,
            emailVerified: true,
            emailVerifiedAt: new Date(),
          },
        });
      } else if (user.status === UserStatus.PENDING && !user.deletedAt) {
        user = await tx.user.update({
          where: { id: user.id },
          data: {
            status: UserStatus.ACTIVE,
            emailVerified: true,
            emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
          },
        });
      }

      await tx.playerCredential.upsert({
        where: { userId: user.id },
        create: { userId: user.id, username: input.username },
        update: {},
      });
      await tx.playerOAuthAccount.create({
        data: {
          userId: user.id,
          provider: input.provider,
          providerUserId: input.providerUserId,
          emailAtLink: input.email,
        },
      });

      return tx.user.findUniqueOrThrow({
        where: { id: user.id },
        include: USER_WITH_CREDENTIAL,
      });
    });
  }

  async attachCredential(input: {
    email: string;
    username: string;
    passwordHash: string;
  }): Promise<PlayerWithCredential> {
    return this.prisma.$transaction(async (tx) => {
      let user = await tx.user.findUnique({ where: { email: input.email } });

      if (!user) {
        user = await tx.user.create({
          data: {
            firstName: input.username,
            lastName: '',
            email: input.email,
            source: UserSource.PLAYER,
            status: UserStatus.PENDING,
          },
        });
      }

      const credential = await tx.playerCredential.findUnique({
        where: { userId: user.id },
      });

      if (!credential) {
        await tx.playerCredential.create({
          data: {
            userId: user.id,
            username: input.username,
            passwordHash: input.passwordHash,
          },
        });
      }

      return tx.user.findUniqueOrThrow({
        where: { id: user.id },
        include: USER_WITH_CREDENTIAL,
      });
    });
  }

  async createEmailToken(input: {
    userId: string;
    purpose: PlayerEmailTokenPurpose;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.playerEmailToken.updateMany({
        where: {
          userId: input.userId,
          purpose: input.purpose,
          consumedAt: null,
        },
        data: { consumedAt: new Date() },
      });
      await tx.playerEmailToken.create({ data: input });
    });
  }

  async verifyEmail(tokenHash: string): Promise<PlayerWithCredential | null> {
    return this.prisma.$transaction(async (tx) => {
      const token = await tx.playerEmailToken.findUnique({
        where: { tokenHash },
      });

      if (
        !token ||
        token.purpose !== PlayerEmailTokenPurpose.VERIFY_EMAIL ||
        token.consumedAt ||
        token.expiresAt.getTime() <= Date.now()
      ) {
        return null;
      }

      const claimed = await tx.playerEmailToken.updateMany({
        where: {
          id: token.id,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });

      if (claimed.count !== 1) return null;

      await tx.user.update({
        where: { id: token.userId },
        data: {
          emailVerified: true,
          emailVerifiedAt: new Date(),
          status: UserStatus.ACTIVE,
        },
      });

      return tx.user.findUniqueOrThrow({
        where: { id: token.userId },
        include: USER_WITH_CREDENTIAL,
      });
    });
  }

  async resetPassword(
    tokenHash: string,
    passwordHash: string,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const token = await tx.playerEmailToken.findUnique({
        where: { tokenHash },
      });

      if (
        !token ||
        token.purpose !== PlayerEmailTokenPurpose.PASSWORD_RESET ||
        token.consumedAt ||
        token.expiresAt.getTime() <= Date.now()
      ) {
        return false;
      }

      const claimed = await tx.playerEmailToken.updateMany({
        where: {
          id: token.id,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });

      if (claimed.count !== 1) return false;

      const updated = await tx.playerCredential.updateMany({
        where: { userId: token.userId },
        data: { passwordHash },
      });

      if (updated.count !== 1) return false;

      await tx.playerEmailToken.updateMany({
        where: {
          userId: token.userId,
          purpose: PlayerEmailTokenPurpose.PASSWORD_RESET,
          consumedAt: null,
        },
        data: { consumedAt: new Date() },
      });
      await tx.playerSession.updateMany({
        where: { userId: token.userId, isActive: true },
        data: { isActive: false, revokedAt: new Date() },
      });

      return true;
    });
  }

  createSession(input: {
    userId: string;
    rememberMe: boolean;
    expiresAt: Date;
    context: PlayerSessionContext;
  }) {
    return this.prisma.playerSession.create({
      data: {
        userId: input.userId,
        rememberMe: input.rememberMe,
        expiresAt: input.expiresAt,
        device: input.context.device,
        browser: input.context.browser,
        os: input.context.os,
        ipAddress: input.context.ipAddress,
        userAgent: input.context.userAgent,
      },
    });
  }

  async storeRefreshToken(input: {
    tokenHash: string;
    sessionId: string;
    userId: string;
    expiresAt: Date;
    createdByIp?: string;
  }): Promise<void> {
    await this.prisma.playerRefreshToken.create({ data: input });
  }

  findRefreshToken(tokenHash: string): Promise<StoredPlayerRefresh | null> {
    return this.prisma.playerRefreshToken.findUnique({
      where: { tokenHash },
      include: REFRESH_WITH_SESSION,
    });
  }

  async rotateRefreshToken(input: {
    currentTokenId: string;
    next: {
      tokenHash: string;
      sessionId: string;
      userId: string;
      expiresAt: Date;
      createdByIp?: string;
    };
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const nextId = randomUUID();
      const rotated = await tx.playerRefreshToken.updateMany({
        where: { id: input.currentTokenId, revokedAt: null },
        data: { revokedAt: new Date(), replacedByTokenId: nextId },
      });

      if (rotated.count !== 1) return false;

      await tx.playerRefreshToken.create({
        data: { id: nextId, ...input.next },
      });
      return true;
    });
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.playerSession.updateMany({
      where: { id: sessionId, isActive: true },
      data: { isActive: false, revokedAt: new Date() },
    });
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.prisma.playerSession.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false, revokedAt: new Date() },
    });
  }

  findSession(id: string) {
    return this.prisma.playerSession.findUnique({
      where: { id },
      include: { user: { include: USER_WITH_CREDENTIAL } },
    });
  }
}
