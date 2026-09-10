import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ItemStatus,
  Prisma,
  RewardCategory,
  RewardDeliveryStatus,
  RewardRedemptionStatus,
} from '@prisma/client';

import { PlayerRewardsService } from '../player-rewards.service';
import type { RewardCodeVault } from '../reward-code-vault.service';
import type {
  PlayerRedemptionRow,
  PlayerRewardsRepository,
} from '../repositories/player-rewards.repository';

const now = new Date('2026-09-09T12:00:00.000Z');

function row(
  overrides: Partial<PlayerRedemptionRow> = {},
): PlayerRedemptionRow {
  return {
    id: 'redemption-1',
    userId: 'player-1',
    rewardId: 'reward-1',
    requestId: '11111111-1111-4111-8111-111111111111',
    payloadHash: 'hash',
    denomination: new Prisma.Decimal('10.00'),
    tokenCost: new Prisma.Decimal('10.00'),
    status: RewardRedemptionStatus.PENDING_FULFILLMENT,
    purchaseTransactionId: 'transaction-1',
    refundTransactionId: null,
    fulfilledAt: null,
    redeemedAt: null,
    cancelledAt: null,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
    reward: {
      id: 'reward-1',
      name: 'Free Coffee',
      company: 'Starbucks',
      category: RewardCategory.FOOD,
      value: '$10 Gift Card',
      description: null,
      terms: null,
      imageId: null,
      status: ItemStatus.ACTIVE,
      stock: null,
      redeemedCount: 0,
      denomination: new Prisma.Decimal('10.00'),
      tokenCost: new Prisma.Decimal('10.00'),
      bonusPercent: 8,
      availableFrom: null,
      availableUntil: null,
      createdByAdminId: 'admin-1',
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      image: null,
    },
    delivery: {
      id: 'delivery-1',
      redemptionId: 'redemption-1',
      status: RewardDeliveryStatus.PENDING,
      supplierReference: null,
      encryptedCode: null,
      failureReason: null,
      deliveredAt: null,
      createdAt: now,
      updatedAt: now,
    },
    ...overrides,
  };
}

describe('PlayerRewardsService', () => {
  let repository: jest.Mocked<PlayerRewardsRepository>;
  let vault: jest.Mocked<RewardCodeVault>;
  let service: PlayerRewardsService;

  beforeEach(() => {
    repository = {
      listCatalog: jest.fn(),
      listOwned: jest.fn(),
      findOwned: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      cancelOwned: jest.fn(),
      fulfill: jest.fn(),
      markRedeemed: jest.fn(),
      expireOwned: jest.fn(),
    } as unknown as jest.Mocked<PlayerRewardsRepository>;
    vault = {
      encrypt: jest.fn(),
      decrypt: jest.fn(),
    } as unknown as jest.Mocked<RewardCodeVault>;
    service = new PlayerRewardsService(repository, vault);
  });

  it('never exposes a bearer code in the redemption list', async () => {
    repository.expireOwned.mockResolvedValue(undefined);
    repository.listOwned.mockResolvedValue([
      row({
        status: RewardRedemptionStatus.FULFILLED,
        delivery: {
          ...row().delivery!,
          status: RewardDeliveryStatus.DELIVERED,
          encryptedCode: 'ciphertext',
        },
      }),
    ]);

    const result = await service.list('player-1');

    expect(result[0]?.code).toBeNull();
    expect(vault.decrypt.mock.calls).toHaveLength(0);
  });

  it('decrypts a code only for the owning detail response', async () => {
    const fulfilled = row({
      status: RewardRedemptionStatus.FULFILLED,
      delivery: {
        ...row().delivery!,
        status: RewardDeliveryStatus.DELIVERED,
        encryptedCode: 'ciphertext',
      },
    });
    repository.expireOwned.mockResolvedValue(undefined);
    repository.findOwned.mockResolvedValue(fulfilled);
    vault.decrypt.mockReturnValue('REAL-CODE');

    await expect(
      service.findOne('player-1', fulfilled.id),
    ).resolves.toMatchObject({
      code: 'REAL-CODE',
    });
    expect(vault.decrypt.mock.calls).toEqual([['ciphertext']]);
  });

  it('rejects request-id reuse with a different payload', async () => {
    repository.create.mockResolvedValue({
      outcome: 'EXISTING',
      redemption: row({ payloadHash: 'different' }),
    });

    await expect(
      service.create('player-1', {
        rewardId: '22222222-2222-4222-8222-222222222222',
        denomination: '10.00',
        requestId: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('maps an exhausted last-stock reservation to a conflict', async () => {
    repository.create.mockResolvedValue({ outcome: 'REWARD_UNAVAILABLE' });

    await expect(
      service.create('player-1', {
        rewardId: '22222222-2222-4222-8222-222222222222',
        denomination: '10.00',
        requestId: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not pretend a missing order was cancelled', async () => {
    repository.cancelOwned.mockResolvedValue(null);
    repository.findOwned.mockResolvedValue(null);

    await expect(service.cancel('player-1', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
