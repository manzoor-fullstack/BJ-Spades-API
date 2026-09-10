import { createHash } from 'node:crypto';

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
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import {
  AnimationEntitlementSource,
  AnimationCategory,
  ItemStatus,
  Prisma,
  TransactionStatus,
  TransactionType,
  UserTier,
} from '@prisma/client';
import { IsUUID } from 'class-validator';

import { formatMoney } from '../../common/money/money.util';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentPlayer } from '../player-auth/decorators/current-player.decorator';
import { PlayerCsrfGuard } from '../player-auth/guards/player-csrf.guard';
import { PlayerJwtGuard } from '../player-auth/guards/player-jwt.guard';
import { PlayerAuthModule } from '../player-auth/player-auth.module';
import type { AuthenticatedPlayer } from '../player-auth/interfaces/player-jwt-payload.interface';
import { PrismaService } from '../prisma/prisma.service';
import { recordLedgerEntry } from '../transactions/repositories/transactions.repository';

class AnimationPurchaseDto {
  @ApiProperty({ description: 'Stable for retries of this purchase action.' })
  @IsUUID()
  requestId!: string;
}

const ANIMATION_INCLUDE = {
  entitlements: true,
} satisfies Prisma.AnimationInclude;

type AnimationRow = Prisma.AnimationGetPayload<{
  include: typeof ANIMATION_INCLUDE;
}>;

function serialize(row: AnimationRow, userId: string, now = new Date()) {
  const entitlement = row.entitlements.find(
    (item) =>
      item.userId === userId &&
      !item.revokedAt &&
      (!item.expiresAt || item.expiresAt > now),
  );
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    price: formatMoney(row.price),
    assetUrl: row.assetUrl,
    effectKey: row.effectKey,
    featured: row.featured,
    vipOnly: row.vipOnly,
    owned: Boolean(entitlement),
    equipped: Boolean(entitlement?.equippedAt),
    source: entitlement?.source ?? null,
    expiresAt: entitlement?.expiresAt ?? null,
  };
}

@Injectable()
class PlayerAnimationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async syncVip(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { tier: true },
    });
    if (!user) return;
    const vipAnimations = await this.prisma.animation.findMany({
      where: { vipOnly: true, status: ItemStatus.ACTIVE },
      select: { id: true },
    });
    if (user.tier === UserTier.VIP) {
      await Promise.all(
        vipAnimations.map((animation) =>
          this.prisma.playerAnimationEntitlement.upsert({
            where: {
              userId_animationId: { userId, animationId: animation.id },
            },
            update: { revokedAt: null, expiresAt: null },
            create: {
              userId,
              animationId: animation.id,
              source: AnimationEntitlementSource.VIP,
            },
          }),
        ),
      );
    } else {
      await this.prisma.playerAnimationEntitlement.updateMany({
        where: {
          userId,
          source: AnimationEntitlementSource.VIP,
          revokedAt: null,
        },
        data: { revokedAt: new Date(), equippedAt: null },
      });
    }
  }

  catalog() {
    return this.prisma.animation.findMany({
      where: { status: ItemStatus.ACTIVE },
      include: ANIMATION_INCLUDE,
      orderBy: [{ featured: 'desc' }, { category: 'asc' }, { name: 'asc' }],
    });
  }

  async purchase(
    userId: string,
    animationId: string,
    requestId: string,
    payloadHash: string,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const retry = await tx.playerAnimationEntitlement.findUnique({
          where: { userId_requestId: { userId, requestId } },
          include: { animation: { include: { entitlements: true } } },
        });
        if (retry)
          return { outcome: 'EXISTING_REQUEST' as const, entitlement: retry };

        const animation = await tx.animation.findFirst({
          where: { id: animationId, status: ItemStatus.ACTIVE },
        });
        if (!animation) return { outcome: 'NOT_FOUND' as const };
        if (animation.vipOnly) return { outcome: 'VIP_ONLY' as const };
        const owned = await tx.playerAnimationEntitlement.findUnique({
          where: { userId_animationId: { userId, animationId } },
        });
        if (owned) return { outcome: 'ALREADY_OWNED' as const };

        const purchase = await recordLedgerEntry(tx, {
          userId,
          type: TransactionType.ANIMATION_PURCHASE,
          amount: animation.price.negated(),
          status: TransactionStatus.COMPLETED,
          reference: `animation-purchase:${userId}:${requestId}`,
          description: animation.name,
        });
        if (purchase.outcome === 'INSUFFICIENT_BALANCE') {
          return {
            outcome: 'INSUFFICIENT_BALANCE' as const,
            balance: purchase.balance,
          };
        }
        if (purchase.outcome !== 'RECORDED')
          return { outcome: 'NOT_FOUND' as const };

        const entitlement = await tx.playerAnimationEntitlement.create({
          data: {
            userId,
            animationId,
            source: AnimationEntitlementSource.PURCHASE,
            pricePaid: animation.price,
            requestId,
            payloadHash,
            purchaseTransactionId: purchase.transaction.id,
          },
          include: { animation: { include: { entitlements: true } } },
        });
        return { outcome: 'CREATED' as const, entitlement };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return { outcome: 'ALREADY_OWNED' as const };
      }
      throw error;
    }
  }

  async equip(userId: string, animationId: string) {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const entitlement = await tx.playerAnimationEntitlement.findFirst({
        where: {
          userId,
          animationId,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        include: { animation: true },
      });
      if (!entitlement) return null;
      await tx.playerAnimationEntitlement.updateMany({
        where: {
          userId,
          equippedAt: { not: null },
          animation: { category: entitlement.animation.category },
        },
        data: { equippedAt: null },
      });
      await tx.playerAnimationEntitlement.update({
        where: { id: entitlement.id },
        data: { equippedAt: now },
      });
      return tx.animation.findUniqueOrThrow({
        where: { id: animationId },
        include: ANIMATION_INCLUDE,
      });
    });
  }
}

@Injectable()
class PlayerAnimationsService {
  constructor(private readonly repository: PlayerAnimationsRepository) {}

  async catalog(userId: string) {
    await this.repository.syncVip(userId);
    return (await this.repository.catalog()).map((row) =>
      serialize(row, userId),
    );
  }

  async purchase(userId: string, animationId: string, requestId: string) {
    const payloadHash = createHash('sha256').update(animationId).digest('hex');
    const result = await this.repository.purchase(
      userId,
      animationId,
      requestId,
      payloadHash,
    );
    switch (result.outcome) {
      case 'CREATED':
        return serialize(result.entitlement.animation, userId);
      case 'EXISTING_REQUEST':
        if (result.entitlement.payloadHash !== payloadHash) {
          throw new UnprocessableEntityException(
            'This requestId was used for another purchase.',
          );
        }
        return serialize(result.entitlement.animation, userId);
      case 'INSUFFICIENT_BALANCE':
        throw new UnprocessableEntityException(
          `Insufficient balance. Available: ${formatMoney(result.balance)} tokens.`,
        );
      case 'ALREADY_OWNED':
        throw new ConflictException('You already own this animation.');
      case 'VIP_ONLY':
        throw new ConflictException(
          'This animation requires an active VIP entitlement.',
        );
      case 'NOT_FOUND':
        throw new NotFoundException('Animation not found.');
    }
  }

  async equip(userId: string, animationId: string) {
    await this.repository.syncVip(userId);
    const row = await this.repository.equip(userId, animationId);
    if (!row)
      throw new ConflictException(
        'You do not have an active entitlement for this animation.',
      );
    return serialize(row, userId);
  }
}

@ApiTags('player-animations')
@Public()
@UseGuards(PlayerJwtGuard)
@Controller('player/v1')
class PlayerAnimationsController {
  constructor(private readonly service: PlayerAnimationsService) {}

  @Get('animations')
  catalog(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service.catalog(player.id);
  }

  @Get('me/animations')
  owned(@CurrentPlayer() player: AuthenticatedPlayer) {
    return this.service
      .catalog(player.id)
      .then((rows) => rows.filter((row) => row.owned));
  }

  @Post('me/animations/:id/purchase')
  @UseGuards(PlayerCsrfGuard)
  purchase(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnimationPurchaseDto,
  ) {
    return this.service.purchase(player.id, id, dto.requestId);
  }

  @Post('me/animations/:id/equip')
  @UseGuards(PlayerCsrfGuard)
  equip(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.equip(player.id, id);
  }
}

@Module({
  imports: [PlayerAuthModule],
  controllers: [PlayerAnimationsController],
  providers: [PlayerAnimationsService, PlayerAnimationsRepository],
})
export class PlayerAnimationsModule {}

export { PlayerAnimationsRepository, PlayerAnimationsService };
export type { AnimationRow };
export { AnimationCategory };
