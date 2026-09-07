import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, VerificationCheckState } from '@prisma/client';

import type { ValidatableUpload } from '../storage/image-validation';
import { MediaService } from '../storage/media.service';
import type { UpdatePlayerProfileDto } from './dto/update-player-profile.dto';
import {
  PlayerProfileRepository,
  type PlayerProfileRecord,
} from './repositories/player-profile.repository';

@Injectable()
export class PlayerProfileService {
  constructor(
    private readonly repository: PlayerProfileRepository,
    private readonly media: MediaService,
  ) {}

  async get(userId: string) {
    return this.toView(await this.requirePlayer(userId));
  }

  async update(userId: string, dto: UpdatePlayerProfileDto) {
    try {
      const { dateOfBirth, ...changes } = dto;
      const result = await this.repository.update(userId, {
        ...changes,
        ...(dateOfBirth !== undefined
          ? {
              dateOfBirth: dateOfBirth
                ? new Date(`${dateOfBirth}T00:00:00.000Z`)
                : null,
            }
          : {}),
      });
      if (!result.player) throw new NotFoundException('Player not found.');
      if (result.detachedAssetId) {
        await this.media.deleteAsset(result.detachedAssetId);
      }
      return this.toView(result.player);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const rawTarget = error.meta?.target;
        const target = Array.isArray(rawTarget)
          ? rawTarget.join(',')
          : typeof rawTarget === 'string'
            ? rawTarget
            : '';
        throw new ConflictException(
          target.includes('phone')
            ? 'That phone number is already in use.'
            : 'That username is unavailable.',
        );
      }
      throw error;
    }
  }

  async uploadAvatar(userId: string, file: ValidatableUpload | undefined) {
    if (!file) throw new BadRequestException('Choose an image to upload.');
    await this.requirePlayer(userId);
    const asset = await this.media.uploadImage(file, 'players', null, {
      maxEdge: 512,
      fit: 'cover',
    });
    try {
      const result = await this.repository.setAvatarImage(userId, asset.id);
      if (!result.player) throw new NotFoundException('Player not found.');
      if (result.oldAssetId && result.oldAssetId !== asset.id) {
        await this.media.deleteAsset(result.oldAssetId);
      }
      return this.toView(result.player);
    } catch (error) {
      await this.media.deleteAsset(asset.id);
      throw error;
    }
  }

  private async requirePlayer(userId: string): Promise<PlayerProfileRecord> {
    const player = await this.repository.findByUserId(userId);
    if (!player || !player.credential)
      throw new NotFoundException('Player not found.');
    return player;
  }

  private toView(player: PlayerProfileRecord) {
    if (!player.credential) throw new NotFoundException('Player not found.');
    const profile = player.playerProfile;
    const verification = player.verification?.kycCheck;
    return {
      id: player.id,
      username: player.credential.username,
      displayName:
        profile?.displayName ?? `${player.firstName} ${player.lastName}`.trim(),
      tagline: profile?.tagline ?? '',
      bio: profile?.bio ?? '',
      firstName: player.firstName,
      lastName: player.lastName,
      email: player.email,
      phone: player.phone ?? '',
      dateOfBirth: profile?.dateOfBirth?.toISOString().slice(0, 10) ?? '',
      location: profile?.location ?? '',
      avatarName: profile?.avatarName ?? 'Poppa Cool',
      avatarBackground: profile?.avatarBackground ?? '#fbbf24',
      avatarUrl: profile?.avatarImage?.url ?? null,
      twitter: profile?.twitter ?? '',
      facebook: profile?.facebook ?? '',
      instagram: profile?.instagram ?? '',
      youtube: profile?.youtube ?? '',
      twitch: profile?.twitch ?? '',
      discord: profile?.discord ?? '',
      website: profile?.website ?? '',
      verificationStatus:
        verification === VerificationCheckState.PASSED
          ? 'VERIFIED'
          : verification === VerificationCheckState.FAILED
            ? 'ACTION_REQUIRED'
            : 'PENDING',
    };
  }
}
