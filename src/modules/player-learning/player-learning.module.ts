import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import {
  ItemStatus,
  LessonProgressStatus,
  PlayerNotificationType,
  Prisma,
  UserTier,
} from '@prisma/client';
import { IsInt, Min } from 'class-validator';

import { Public } from '../auth/decorators/public.decorator';
import { CurrentPlayer } from '../player-auth/decorators/current-player.decorator';
import { PlayerCsrfGuard } from '../player-auth/guards/player-csrf.guard';
import { PlayerJwtGuard } from '../player-auth/guards/player-jwt.guard';
import { PlayerAuthModule } from '../player-auth/player-auth.module';
import type { AuthenticatedPlayer } from '../player-auth/interfaces/player-jwt-payload.interface';
import { PrismaService } from '../prisma/prisma.service';

class LessonProgressDto {
  @ApiProperty({ minimum: 0, description: 'Zero-based section just viewed.' })
  @IsInt()
  @Min(0)
  sectionIndex!: number;
}

const TIER_RANK: Record<UserTier, number> = {
  [UserTier.PLAYER]: 0,
  [UserTier.PREMIUM]: 1,
  [UserTier.VIP]: 2,
};

type LessonRow = Prisma.LessonGetPayload<{ include: { progress: true } }>;

function sections(row: LessonRow): Array<{ title: string; body: string }> {
  if (!Array.isArray(row.content)) return [];
  return row.content.filter(
    (entry): entry is { title: string; body: string } =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).title === 'string' &&
      typeof (entry as Record<string, unknown>).body === 'string',
  );
}

function serialize(
  row: LessonRow,
  userId: string,
  tier: UserTier,
  detail = false,
) {
  const progress = row.progress.find((item) => item.userId === userId);
  const content = sections(row);
  const locked = TIER_RANK[tier] < TIER_RANK[row.requiredTier];
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    durationMinutes: row.durationMinutes,
    difficulty: row.difficulty,
    moduleCount: row.moduleCount,
    mediaUrl: row.mediaUrl,
    requiredTier: row.requiredTier,
    contentVersion: row.contentVersion,
    locked,
    progress: {
      status: progress?.status ?? LessonProgressStatus.NOT_STARTED,
      currentSection: progress?.currentSection ?? 0,
      percent:
        progress?.status === LessonProgressStatus.COMPLETED
          ? 100
          : content.length > 0
            ? Math.round(
                ((progress?.currentSection ?? 0) / content.length) * 100,
              )
            : 0,
      completedAt: progress?.completedAt ?? null,
    },
    // Learning carries no XP. It cannot modify competitive progression.
    xpAward: 0,
    ...(detail && !locked ? { sections: content } : {}),
  };
}

@Injectable()
class PlayerLearningService {
  constructor(private readonly prisma: PrismaService) {}

  private async userTier(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { tier: true },
    });
    if (!user) throw new NotFoundException('Player not found.');
    return user.tier;
  }

  async catalog(userId: string) {
    const [tier, lessons] = await Promise.all([
      this.userTier(userId),
      this.prisma.lesson.findMany({
        where: { status: ItemStatus.ACTIVE },
        include: { progress: { where: { userId } } },
        orderBy: [{ difficulty: 'asc' }, { title: 'asc' }],
      }),
    ]);
    return lessons.map((lesson) => serialize(lesson, userId, tier));
  }

  async detail(userId: string, lessonId: string) {
    const [tier, lesson] = await Promise.all([
      this.userTier(userId),
      this.prisma.lesson.findFirst({
        where: { id: lessonId, status: ItemStatus.ACTIVE },
        include: { progress: { where: { userId } } },
      }),
    ]);
    if (!lesson) throw new NotFoundException('Lesson not found.');
    if (TIER_RANK[tier] < TIER_RANK[lesson.requiredTier]) {
      throw new ForbiddenException(
        `This lesson requires ${lesson.requiredTier} access.`,
      );
    }
    return serialize(lesson, userId, tier, true);
  }

  async start(userId: string, lessonId: string) {
    await this.detail(userId, lessonId);
    const lesson = await this.prisma.lesson.findUniqueOrThrow({
      where: { id: lessonId },
    });
    const existing = await this.prisma.lessonProgress.findUnique({
      where: { userId_lessonId: { userId, lessonId } },
    });
    await this.prisma.lessonProgress.upsert({
      where: { userId_lessonId: { userId, lessonId } },
      create: {
        userId,
        lessonId,
        status: LessonProgressStatus.IN_PROGRESS,
        currentSection: 0,
        contentVersion: lesson.contentVersion,
        startedAt: new Date(),
      },
      update:
        existing?.contentVersion === lesson.contentVersion
          ? { startedAt: existing.startedAt ?? new Date() }
          : {
              status: LessonProgressStatus.IN_PROGRESS,
              currentSection: 0,
              contentVersion: lesson.contentVersion,
              startedAt: new Date(),
              completedAt: null,
            },
    });
    return this.detail(userId, lessonId);
  }

  async advance(userId: string, lessonId: string, sectionIndex: number) {
    const detail = await this.detail(userId, lessonId);
    const content =
      (detail as { sections?: Array<{ title: string; body: string }> })
        .sections ?? [];
    if (sectionIndex >= content.length)
      throw new UnprocessableEntityException('Section does not exist.');
    const progress = await this.prisma.lessonProgress.findUnique({
      where: { userId_lessonId: { userId, lessonId } },
    });
    if (!progress)
      throw new ConflictException(
        'Start the lesson before recording progress.',
      );
    if (sectionIndex > progress.currentSection + 1) {
      throw new ConflictException(
        'Lesson sections must be completed in order.',
      );
    }
    const complete = sectionIndex === content.length - 1;
    await this.prisma.$transaction(async (tx) => {
      await tx.lessonProgress.update({
        where: { id: progress.id },
        data: {
          currentSection: Math.max(progress.currentSection, sectionIndex),
          status: complete
            ? LessonProgressStatus.COMPLETED
            : LessonProgressStatus.IN_PROGRESS,
          completedAt: complete
            ? (progress.completedAt ?? new Date())
            : progress.completedAt,
        },
      });
      if (complete) {
        await tx.playerNotification.upsert({
          where: {
            userId_eventKey: {
              userId,
              eventKey: `lesson:${lessonId}:completed`,
            },
          },
          create: {
            userId,
            eventKey: `lesson:${lessonId}:completed`,
            type: PlayerNotificationType.LEARNING,
            title: 'Lesson completed',
            message: `You completed ${detail.title}.`,
            targetPage: 'school',
            targetId: lessonId,
          },
          update: {},
        });
      }
    });
    return this.detail(userId, lessonId);
  }
}

@ApiTags('player-learning')
@Public()
@UseGuards(PlayerJwtGuard)
@Controller('player/v1')
class PlayerLearningController {
  constructor(private readonly service: PlayerLearningService) {}

  @Get('lessons')
  catalog(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.catalog(player.id);
  }

  @Get('lessons/:id')
  detail(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.detail(player.id, id);
  }

  @Post('me/learning/:id/start')
  @UseGuards(PlayerCsrfGuard)
  start(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.start(player.id, id);
  }

  @Post('me/learning/:id/progress')
  @UseGuards(PlayerCsrfGuard)
  progress(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LessonProgressDto,
  ) {
    return this.service.advance(player.id, id, dto.sectionIndex);
  }
}

@Module({
  imports: [PlayerAuthModule],
  controllers: [PlayerLearningController],
  providers: [PlayerLearningService],
})
export class PlayerLearningModule {}

export { PlayerLearningService };
