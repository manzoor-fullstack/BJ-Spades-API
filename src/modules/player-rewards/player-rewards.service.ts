import { createHash } from 'node:crypto';

import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { RewardRedemptionStatus } from '@prisma/client';

import { formatMoney } from '../../common/money/money.util';
import type { CreateRedemptionDto } from './dto/create-redemption.dto';
import type { FulfillRedemptionDto } from './dto/fulfill-redemption.dto';
import {
  hasDeliverableCode,
  toPlayerRedemption,
  toPlayerReward,
} from './player-rewards.serializer';
import { RewardCodeVault } from './reward-code-vault.service';
import { PlayerRewardsRepository } from './repositories/player-rewards.repository';

@Injectable()
export class PlayerRewardsService {
  constructor(
    private readonly repository: PlayerRewardsRepository,
    private readonly vault: RewardCodeVault,
  ) {}

  async catalog() {
    return (await this.repository.listCatalog(new Date())).map(toPlayerReward);
  }

  async list(userId: string) {
    const now = new Date();
    await this.repository.expireOwned(userId, now);
    return (await this.repository.listOwned(userId)).map((row) =>
      toPlayerRedemption(row),
    );
  }

  async findOne(userId: string, id: string) {
    await this.repository.expireOwned(userId, new Date());
    const row = await this.repository.findOwned(userId, id);
    if (!row) throw new NotFoundException('Redemption not found.');
    const code = hasDeliverableCode(row)
      ? this.vault.decrypt(row.delivery!.encryptedCode!)
      : null;
    return toPlayerRedemption(row, code);
  }

  async create(userId: string, input: CreateRedemptionDto) {
    const payloadHash = this.payloadHash(input.rewardId, input.denomination);
    const result = await this.repository.create(userId, {
      ...input,
      payloadHash,
    });
    switch (result.outcome) {
      case 'CREATED':
        return toPlayerRedemption(result.redemption);
      case 'EXISTING':
        if (result.redemption.payloadHash !== payloadHash) {
          throw new UnprocessableEntityException(
            'This requestId was already used for a different reward order.',
          );
        }
        return toPlayerRedemption(result.redemption);
      case 'INSUFFICIENT_BALANCE':
        throw new UnprocessableEntityException(
          `Insufficient balance. Available: ${formatMoney(result.balance)} tokens.`,
        );
      case 'INVALID_DENOMINATION':
        throw new UnprocessableEntityException(
          'The selected denomination is not available for this reward.',
        );
      case 'PLAYER_NOT_FOUND':
        throw new NotFoundException('Player not found.');
      case 'REWARD_UNAVAILABLE':
        throw new ConflictException('This reward is no longer available.');
    }
  }

  async cancel(userId: string, id: string) {
    const row = await this.repository.cancelOwned(userId, id);
    if (!row) {
      const existing = await this.repository.findOwned(userId, id);
      if (!existing) throw new NotFoundException('Redemption not found.');
      throw new ConflictException(
        'Only pending reward orders can be cancelled.',
      );
    }
    return toPlayerRedemption(row);
  }

  async redeem(userId: string, id: string) {
    const now = new Date();
    const row = await this.repository.markRedeemed(userId, id, now);
    if (!row) throw new NotFoundException('Redemption not found.');
    if (row.status === RewardRedemptionStatus.EXPIRED) {
      throw new ConflictException('This reward has expired.');
    }
    if (row.status !== RewardRedemptionStatus.REDEEMED) {
      throw new ConflictException('This reward is not ready to redeem.');
    }
    return toPlayerRedemption(row);
  }

  async fulfill(id: string, input: FulfillRedemptionDto) {
    const current = await this.repository.findById(id);
    if (!current) throw new NotFoundException('Redemption not found.');
    if (
      current.status === RewardRedemptionStatus.FULFILLED ||
      current.status === RewardRedemptionStatus.REDEEMED
    ) {
      const sameReference =
        current.delivery?.supplierReference === input.supplierReference;
      const sameCode =
        current.delivery?.encryptedCode &&
        this.vault.decrypt(current.delivery.encryptedCode) === input.code;
      if (!sameReference || !sameCode) {
        throw new ConflictException('This order was already fulfilled.');
      }
      return toPlayerRedemption(current);
    }
    const encryptedCode = this.vault.encrypt(input.code);
    const row = await this.repository.fulfill(id, {
      encryptedCode,
      supplierReference: input.supplierReference,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    });
    if (!row) throw new NotFoundException('Redemption not found.');
    if (
      row.status !== RewardRedemptionStatus.FULFILLED &&
      row.status !== RewardRedemptionStatus.REDEEMED
    ) {
      throw new ConflictException('This reward order cannot be fulfilled.');
    }
    // The admin response intentionally omits the bearer code.
    return toPlayerRedemption(row);
  }

  private payloadHash(rewardId: string, denomination: string): string {
    return createHash('sha256')
      .update(JSON.stringify({ rewardId, denomination }))
      .digest('hex');
  }
}
