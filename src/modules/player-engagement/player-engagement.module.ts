import {
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  ItemStatus,
  PlayerMembershipStatus,
  PlayerNotificationType,
  Prisma,
  TournamentStatus,
  UserTier,
} from '@prisma/client';
import { Equals, IsBoolean, IsEmail, IsOptional } from 'class-validator';

import { Public } from '../auth/decorators/public.decorator';
import { CurrentPlayer } from '../player-auth/decorators/current-player.decorator';
import { PlayerCsrfGuard } from '../player-auth/guards/player-csrf.guard';
import { PlayerJwtGuard } from '../player-auth/guards/player-jwt.guard';
import type { AuthenticatedPlayer } from '../player-auth/interfaces/player-jwt-payload.interface';
import { PlayerAuthModule } from '../player-auth/player-auth.module';
import { PrismaService } from '../prisma/prisma.service';

class NotificationPreferenceDto {
  @IsOptional()
  @IsBoolean()
  inAppEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;
}

class EarlyAccessLeadDto {
  @IsEmail()
  email!: string;

  @Equals(true, {
    message: 'Consent is required to join the early access list.',
  })
  consent!: boolean;
}

const serializeNotification = (row: {
  id: string;
  type: PlayerNotificationType;
  title: string;
  message: string;
  targetPage: string | null;
  targetId: string | null;
  readAt: Date | null;
  createdAt: Date;
}) => ({ ...row, unread: row.readAt === null });

@Injectable()
export class PlayerEngagementService {
  constructor(private readonly prisma: PrismaService) {}

  async notificationPreferences(userId: string) {
    const row = await this.prisma.playerNotificationPreference.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    return { ...row, emailAvailable: false };
  }

  async updateNotificationPreferences(
    userId: string,
    input: NotificationPreferenceDto,
  ) {
    if (input.emailEnabled) {
      throw new UnprocessableEntityException(
        'Email notifications are unavailable until a delivery provider is configured.',
      );
    }
    const row = await this.prisma.playerNotificationPreference.upsert({
      where: { userId },
      create: {
        userId,
        inAppEnabled: input.inAppEnabled ?? true,
        emailEnabled: false,
      },
      update: {
        ...(input.inAppEnabled === undefined
          ? {}
          : { inAppEnabled: input.inAppEnabled }),
        emailEnabled: false,
      },
    });
    return { ...row, emailAvailable: false };
  }

  async notifications(userId: string, page = 1, limit = 20) {
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    ) {
      throw new UnprocessableEntityException(
        'Notification page and limit are invalid.',
      );
    }
    const preference = await this.notificationPreferences(userId);
    if (!preference.inAppEnabled)
      return {
        items: [],
        unreadCount: 0,
        meta: { page, limit, total: 0, totalPages: 0 },
      };
    await this.prisma.playerNotification.upsert({
      where: { userId_eventKey: { userId, eventKey: 'welcome:v1' } },
      create: {
        userId,
        eventKey: 'welcome:v1',
        type: PlayerNotificationType.SYSTEM,
        title: 'Welcome to BJ Spades',
        message: 'Your player dashboard is ready.',
        targetPage: 'overview',
      },
      update: {},
    });
    const [rows, total, unreadCount] = await Promise.all([
      this.prisma.playerNotification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.playerNotification.count({ where: { userId } }),
      this.prisma.playerNotification.count({ where: { userId, readAt: null } }),
    ]);
    return {
      items: rows.map(serializeNotification),
      unreadCount,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async readNotification(userId: string, id: string) {
    const result = await this.prisma.playerNotification.updateMany({
      where: { id, userId },
      data: { readAt: new Date() },
    });
    if (!result.count) throw new NotFoundException('Notification not found.');
    const row = await this.prisma.playerNotification.findUniqueOrThrow({
      where: { id },
    });
    return serializeNotification(row);
  }

  async readAll(userId: string) {
    await this.prisma.playerNotification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return this.notifications(userId);
  }

  async search(userId: string, rawQuery: string | undefined) {
    const query = rawQuery?.trim() ?? '';
    if (query.length < 2) return [];
    if (query.length > 80) {
      throw new UnprocessableEntityException(
        'Search is limited to 80 characters.',
      );
    }
    const contains = { contains: query, mode: Prisma.QueryMode.insensitive };
    const [tournaments, rewards, merchandise, lessons, animations] =
      await Promise.all([
        this.prisma.tournament.findMany({
          where: {
            name: contains,
            status: {
              in: [
                TournamentStatus.SCHEDULED,
                TournamentStatus.REGISTERING,
                TournamentStatus.IN_PROGRESS,
              ],
            },
            OR: [{ visibility: 'PUBLIC' }, { createdByPlayerId: userId }],
          },
          select: { id: true, name: true, startsAt: true },
          take: 5,
        }),
        this.prisma.reward.findMany({
          where: {
            status: ItemStatus.ACTIVE,
            OR: [{ name: contains }, { company: contains }],
          },
          select: { id: true, name: true, company: true },
          take: 5,
        }),
        this.prisma.merchandise.findMany({
          where: { status: ItemStatus.ACTIVE, name: contains },
          select: { id: true, name: true, description: true },
          take: 5,
        }),
        this.prisma.lesson.findMany({
          where: {
            status: ItemStatus.ACTIVE,
            OR: [{ title: contains }, { description: contains }],
          },
          select: { id: true, title: true, difficulty: true },
          take: 5,
        }),
        this.prisma.animation.findMany({
          where: { status: ItemStatus.ACTIVE, name: contains },
          select: { id: true, name: true, category: true },
          take: 5,
        }),
      ]);
    return [
      ...tournaments.map((row) => ({
        id: row.id,
        type: 'TOURNAMENT',
        title: row.name,
        subtitle: `Starts ${row.startsAt.toISOString()}`,
        targetPage: 'tournaments',
      })),
      ...rewards.map((row) => ({
        id: row.id,
        type: 'REWARD',
        title: row.name,
        subtitle: row.company,
        targetPage: 'rewards',
      })),
      ...merchandise.map((row) => ({
        id: row.id,
        type: 'MERCHANDISE',
        title: row.name,
        subtitle: row.description,
        targetPage: 'rewards',
      })),
      ...lessons.map((row) => ({
        id: row.id,
        type: 'LESSON',
        title: row.title,
        subtitle: row.difficulty,
        targetPage: 'school',
      })),
      ...animations.map((row) => ({
        id: row.id,
        type: 'ANIMATION',
        title: row.name,
        subtitle: row.category,
        targetPage: 'animations',
      })),
    ];
  }

  async funnelContent() {
    const [
      registeredPlayers,
      waitlistCount,
      activeTournaments,
      animations,
      rewards,
    ] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.earlyAccessLead.count(),
      this.prisma.tournament.count({
        where: {
          status: {
            in: [
              TournamentStatus.SCHEDULED,
              TournamentStatus.REGISTERING,
              TournamentStatus.IN_PROGRESS,
            ],
          },
        },
      }),
      this.prisma.animation.count({ where: { status: ItemStatus.ACTIVE } }),
      this.prisma.reward.count({ where: { status: ItemStatus.ACTIVE } }),
    ]);
    return {
      registeredPlayers,
      waitlistCount,
      activeTournaments,
      animations,
      rewards,
    };
  }

  async joinEarlyAccess(userId: string, input: EarlyAccessLeadDto) {
    const email = input.email.trim().toLowerCase();
    const [existing, existingForUser] = await Promise.all([
      this.prisma.earlyAccessLead.findUnique({ where: { email } }),
      this.prisma.earlyAccessLead.findUnique({ where: { userId } }),
    ]);
    if (existing?.userId && existing.userId !== userId) {
      throw new ConflictException(
        'That email is already registered for early access.',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const lead = existingForUser
        ? await tx.earlyAccessLead.update({
            where: { id: existingForUser.id },
            data: { email, consentAt: new Date() },
          })
        : await tx.earlyAccessLead.upsert({
            where: { email },
            create: { userId, email, consentAt: new Date() },
            update: { userId, consentAt: new Date() },
          });
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { tier: true },
      });
      const membership = await tx.playerMembership.upsert({
        where: { userId },
        create: {
          userId,
          tier: user.tier,
          status:
            user.tier === UserTier.PLAYER
              ? PlayerMembershipStatus.WAITLISTED
              : PlayerMembershipStatus.ACTIVE,
          startedAt: user.tier === UserTier.PLAYER ? null : new Date(),
        },
        update: {},
      });
      await tx.playerNotification.upsert({
        where: { userId_eventKey: { userId, eventKey: 'early-access:joined' } },
        create: {
          userId,
          eventKey: 'early-access:joined',
          type: PlayerNotificationType.MEMBERSHIP,
          title: 'Early access confirmed',
          message: 'You are on the BJ Spades early access list.',
          targetPage: 'salesfunnel',
        },
        update: {},
      });
      return {
        id: lead.id,
        email: lead.email,
        status: membership.status,
        consentAt: lead.consentAt,
      };
    });
  }

  async membership(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { tier: true },
    });
    let membership = await this.prisma.playerMembership.findUnique({
      where: { userId },
    });
    if (
      membership?.status === PlayerMembershipStatus.ACTIVE &&
      membership.expiresAt &&
      membership.expiresAt <= new Date()
    ) {
      membership = await this.prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: userId },
          data: { tier: UserTier.PLAYER },
        });
        return tx.playerMembership.update({
          where: { userId },
          data: {
            status: PlayerMembershipStatus.EXPIRED,
            tier: UserTier.PLAYER,
          },
        });
      });
    } else if (
      user.tier !== UserTier.PLAYER &&
      (!membership ||
        membership.status !== PlayerMembershipStatus.ACTIVE ||
        membership.tier !== user.tier)
    ) {
      membership = await this.prisma.playerMembership.upsert({
        where: { userId },
        create: {
          userId,
          tier: user.tier,
          status: PlayerMembershipStatus.ACTIVE,
          startedAt: new Date(),
        },
        update: {
          tier: user.tier,
          status: PlayerMembershipStatus.ACTIVE,
          startedAt: membership?.startedAt ?? new Date(),
          cancelledAt: null,
        },
      });
    }
    const lead = await this.prisma.earlyAccessLead.findUnique({
      where: { userId },
    });
    return {
      tier: membership?.tier ?? user.tier,
      status:
        membership?.status ?? (lead ? PlayerMembershipStatus.WAITLISTED : null),
      startedAt: membership?.startedAt ?? null,
      expiresAt: membership?.expiresAt ?? null,
      cancelledAt: membership?.cancelledAt ?? null,
      earlyAccessEmail: lead?.email ?? null,
      canCancel: membership?.status === PlayerMembershipStatus.ACTIVE,
    };
  }

  async cancelMembership(userId: string) {
    const membership = await this.prisma.playerMembership.findUnique({
      where: { userId },
    });
    if (!membership || membership.status !== PlayerMembershipStatus.ACTIVE) {
      throw new ConflictException('There is no active membership to cancel.');
    }
    await this.prisma.$transaction([
      this.prisma.playerMembership.update({
        where: { userId },
        data: {
          status: PlayerMembershipStatus.CANCELLED,
          cancelledAt: new Date(),
          tier: UserTier.PLAYER,
        },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { tier: UserTier.PLAYER },
      }),
    ]);
    return this.membership(userId);
  }
}

@ApiTags('player-engagement')
@Public()
@UseGuards(PlayerJwtGuard)
@Controller('player/v1')
class PlayerEngagementController {
  constructor(private readonly service: PlayerEngagementService) {}

  @Get('notifications')
  notifications(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Query('page') rawPage?: string,
    @Query('limit') rawLimit?: string,
  ) {
    return this.service.notifications(
      player.id,
      rawPage === undefined ? 1 : Number(rawPage),
      rawLimit === undefined ? 20 : Number(rawLimit),
    );
  }

  @Post('notifications/read-all')
  @UseGuards(PlayerCsrfGuard)
  readAll(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.readAll(player.id);
  }

  @Post('notifications/:id/read')
  @UseGuards(PlayerCsrfGuard)
  read(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.readNotification(player.id, id);
  }

  @Get('me/notification-preferences')
  preferences(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.notificationPreferences(player.id);
  }

  @Patch('me/notification-preferences')
  @UseGuards(PlayerCsrfGuard)
  updatePreferences(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Body() input: NotificationPreferenceDto,
  ) {
    return this.service.updateNotificationPreferences(player.id, input);
  }

  @Get('search')
  search(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Query('q') query?: string,
  ) {
    return this.service.search(player.id, query);
  }

  @Get('sales-funnel')
  funnel() {
    return this.service.funnelContent();
  }

  @Post('sales-funnel/leads')
  @UseGuards(PlayerCsrfGuard)
  join(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Body() input: EarlyAccessLeadDto,
  ) {
    return this.service.joinEarlyAccess(player.id, input);
  }

  @Get('me/membership')
  membership(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.membership(player.id);
  }

  @Post('me/membership/cancel')
  @UseGuards(PlayerCsrfGuard)
  cancel(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.cancelMembership(player.id);
  }
}

@Module({
  imports: [PlayerAuthModule],
  controllers: [PlayerEngagementController],
  providers: [PlayerEngagementService],
  exports: [PlayerEngagementService],
})
export class PlayerEngagementModule {}
