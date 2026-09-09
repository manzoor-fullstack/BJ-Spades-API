import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

const PROFILE_INCLUDE = {
  credential: true,
  playerProfile: { include: { avatarImage: true } },
  verification: true,
} satisfies Prisma.UserInclude;

export type PlayerProfileRecord = Prisma.UserGetPayload<{
  include: typeof PROFILE_INCLUDE;
}>;

export interface PlayerProfileChanges {
  username?: string;
  firstName?: string;
  lastName?: string;
  phone?: string | null;
  displayName?: string;
  tagline?: string | null;
  bio?: string | null;
  dateOfBirth?: Date | null;
  location?: string | null;
  avatarName?: string;
  avatarBackground?: string;
  twitter?: string | null;
  facebook?: string | null;
  instagram?: string | null;
  youtube?: string | null;
  twitch?: string | null;
  discord?: string | null;
  website?: string | null;
}

@Injectable()
export class PlayerProfileRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByUserId(userId: string): Promise<PlayerProfileRecord | null> {
    return this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: PROFILE_INCLUDE,
    });
  }

  async update(
    userId: string,
    changes: PlayerProfileChanges,
  ): Promise<{
    player: PlayerProfileRecord | null;
    detachedAssetId: string | null;
  }> {
    const detachedAssetId = await this.prisma.$transaction(async (tx) => {
      const current = await tx.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: {
          firstName: true,
          lastName: true,
          playerProfile: { select: { avatarImageId: true } },
        },
      });
      if (!current) return null;

      const userData: Prisma.UserUpdateInput = {};
      if (changes.firstName !== undefined)
        userData.firstName = changes.firstName;
      if (changes.lastName !== undefined) userData.lastName = changes.lastName;
      if (changes.phone !== undefined) userData.phone = changes.phone;
      if (Object.keys(userData).length > 0) {
        await tx.user.update({ where: { id: userId }, data: userData });
      }

      if (changes.username !== undefined) {
        await tx.playerCredential.update({
          where: { userId },
          data: { username: changes.username.toLowerCase() },
        });
      }

      const profileData: Prisma.PlayerProfileUncheckedUpdateInput = {};
      const profileKeys = [
        'displayName',
        'tagline',
        'bio',
        'dateOfBirth',
        'location',
        'avatarName',
        'avatarBackground',
        'twitter',
        'facebook',
        'instagram',
        'youtube',
        'twitch',
        'discord',
        'website',
      ] as const;
      for (const key of profileKeys) {
        if (changes[key] !== undefined)
          profileData[key] = changes[key] as never;
      }
      if (changes.avatarName !== undefined) profileData.avatarImageId = null;
      if (Object.keys(profileData).length > 0) {
        const createData: Prisma.PlayerProfileUncheckedCreateInput = {
          userId,
          displayName:
            changes.displayName ??
            `${changes.firstName ?? current.firstName} ${changes.lastName ?? current.lastName}`.trim(),
          ...(changes.tagline !== undefined
            ? { tagline: changes.tagline }
            : {}),
          ...(changes.bio !== undefined ? { bio: changes.bio } : {}),
          ...(changes.dateOfBirth !== undefined
            ? { dateOfBirth: changes.dateOfBirth }
            : {}),
          ...(changes.location !== undefined
            ? { location: changes.location }
            : {}),
          ...(changes.avatarName !== undefined
            ? { avatarName: changes.avatarName }
            : {}),
          ...(changes.avatarBackground !== undefined
            ? { avatarBackground: changes.avatarBackground }
            : {}),
          ...(changes.twitter !== undefined
            ? { twitter: changes.twitter }
            : {}),
          ...(changes.facebook !== undefined
            ? { facebook: changes.facebook }
            : {}),
          ...(changes.instagram !== undefined
            ? { instagram: changes.instagram }
            : {}),
          ...(changes.youtube !== undefined
            ? { youtube: changes.youtube }
            : {}),
          ...(changes.twitch !== undefined ? { twitch: changes.twitch } : {}),
          ...(changes.discord !== undefined
            ? { discord: changes.discord }
            : {}),
          ...(changes.website !== undefined
            ? { website: changes.website }
            : {}),
        };
        await tx.playerProfile.upsert({
          where: { userId },
          update: profileData,
          create: createData,
        });
      }
      return changes.avatarName !== undefined
        ? (current.playerProfile?.avatarImageId ?? null)
        : null;
    });
    return { player: await this.findByUserId(userId), detachedAssetId };
  }

  async setAvatarImage(
    userId: string,
    avatarImageId: string,
  ): Promise<{
    oldAssetId: string | null;
    player: PlayerProfileRecord | null;
  }> {
    const oldAssetId = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: {
          firstName: true,
          lastName: true,
          playerProfile: { select: { avatarImageId: true } },
        },
      });
      if (!user) return null;
      await tx.playerProfile.upsert({
        where: { userId },
        update: { avatarImageId },
        create: {
          userId,
          displayName: `${user.firstName} ${user.lastName}`.trim(),
          avatarImageId,
        },
      });
      return user.playerProfile?.avatarImageId ?? null;
    });
    return { oldAssetId, player: await this.findByUserId(userId) };
  }
}
