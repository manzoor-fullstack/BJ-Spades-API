import { createHash } from 'node:crypto';
import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { formatMoney, toMoney } from '../../common/money/money.util';
import { SettingsService } from '../settings/settings.service';
import { PayoutsService } from '../payouts/payouts.service';
import { CreateWithdrawalDto } from './dto/create-withdrawal.dto';
import { PlayerWithdrawalsRepository } from './repositories/player-withdrawals.repository';
import {
  toPlayerPayoutDestination,
  toPlayerWithdrawal,
} from './player-withdrawals.serializer';

const MINIMUM_WITHDRAWAL = toMoney('100.00');

@Injectable()
export class PlayerWithdrawalsService {
  constructor(
    private readonly repository: PlayerWithdrawalsRepository,
    private readonly settings: SettingsService,
    private readonly payouts: PayoutsService,
  ) {}

  async destinations(userId: string) {
    return (await this.repository.listDestinations(userId)).map(
      toPlayerPayoutDestination,
    );
  }

  async list(userId: string) {
    return (await this.repository.listOwned(userId)).map(toPlayerWithdrawal);
  }

  onboarding(userId: string) {
    return this.payouts.createPlayerOnboardingLink(userId);
  }

  async findOne(userId: string, id: string) {
    const row = await this.repository.findOwned(userId, id);
    if (!row) throw new NotFoundException('Withdrawal not found.');
    return toPlayerWithdrawal(row);
  }

  async create(userId: string, input: CreateWithdrawalDto) {
    if (await this.settings.isPayoutsFrozen()) {
      throw new ServiceUnavailableException(
        'Withdrawals are temporarily unavailable.',
      );
    }
    const amount = toMoney(input.amount);
    if (amount.lessThan(MINIMUM_WITHDRAWAL)) {
      throw new UnprocessableEntityException(
        'Minimum withdrawal is 100.00 tokens.',
      );
    }
    const normalized = amount.toFixed(2);
    const payloadHash = createHash('sha256')
      .update(`${normalized}:${input.destinationId}`)
      .digest('hex');
    const result = await this.repository.create(userId, {
      requestId: input.requestId,
      amount: normalized,
      destinationId: input.destinationId,
      payloadHash,
    });
    if (result.outcome === 'PLAYER_NOT_FOUND')
      throw new NotFoundException('Player not found.');
    if (result.outcome === 'INELIGIBLE') {
      throw new UnprocessableEntityException(
        'Identity, age, country, tax, fraud and Stripe payout verification must be complete.',
      );
    }
    if (result.outcome === 'OPEN_DISPUTE') {
      throw new UnprocessableEntityException(
        'Withdrawals are held while a dispute is open.',
      );
    }
    if (result.outcome === 'DESTINATION_INVALID') {
      throw new UnprocessableEntityException(
        'Choose a verified Stripe payout destination owned by this account.',
      );
    }
    if (result.outcome === 'INSUFFICIENT_BALANCE') {
      throw new UnprocessableEntityException(
        `Insufficient balance. Available: ${formatMoney(result.balance)} tokens.`,
      );
    }
    if (
      result.outcome === 'EXISTING' &&
      result.withdrawal.payloadHash !== payloadHash
    ) {
      throw new UnprocessableEntityException(
        'This requestId was already used for a different withdrawal.',
      );
    }
    return toPlayerWithdrawal(result.withdrawal);
  }

  async cancel(userId: string, id: string) {
    const existing = await this.repository.findOwned(userId, id);
    if (!existing) throw new NotFoundException('Withdrawal not found.');
    const cancelled = await this.repository.cancelOwned(userId, id);
    if (!cancelled)
      throw new UnprocessableEntityException(
        'Only a withdrawal awaiting review can be cancelled.',
      );
    return toPlayerWithdrawal(cancelled);
  }
}
