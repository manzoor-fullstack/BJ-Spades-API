import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ItemStatus, RewardCategory } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { LOW_STOCK_THRESHOLD } from '../../../common/constants/stock';
import type { AuthenticatedAdmin } from '../../auth/interfaces/authenticated-admin.interface';
import type { MediaService } from '../../storage/media.service';
import { CreateRewardDto } from '../dto/create-reward.dto';
import { QueryRewardsDto } from '../dto/query-rewards.dto';
import type {
  RewardsRepository,
  RewardWithRelations,
} from '../repositories/rewards.repository';
import { RewardsService } from '../rewards.service';

type MockedRewards = { [K in keyof RewardsRepository]: jest.Mock };
type MockedMedia = { [K in keyof MediaService]: jest.Mock };

const ADMIN: AuthenticatedAdmin = {
  id: 'admin-1',
  email: 'admin@bjspades.com',
  role: 'SUPER_ADMIN',
  roleId: 'role-1',
  sessionId: 'session-1',
};

const REWARD_ID = '33333333-3333-4333-8333-000000000001';

function rewardFixture(
  overrides: Partial<RewardWithRelations> = {},
): RewardWithRelations {
  return {
    id: REWARD_ID,
    name: 'Free Coffee',
    company: 'Starbucks',
    category: RewardCategory.FOOD,
    value: '$10 Gift Card',
    description: null,
    terms: null,
    imageId: null,
    image: null,
    status: ItemStatus.ACTIVE,
    stock: null,
    redeemedCount: 0,
    createdByAdminId: ADMIN.id,
    deletedAt: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

function createDto(overrides: Record<string, unknown> = {}): CreateRewardDto {
  return plainToInstance(
    CreateRewardDto,
    {
      rewardName: 'Free Coffee',
      company: 'Starbucks',
      value: '$10 Gift Card',
      ...overrides,
    },
    { enableImplicitConversion: true },
  );
}

function query(raw: Record<string, unknown> = {}): QueryRewardsDto {
  return plainToInstance(QueryRewardsDto, raw, {
    enableImplicitConversion: true,
  });
}

describe('RewardsService', () => {
  let repository: MockedRewards;
  let media: MockedMedia;
  let service: RewardsService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findById: jest.fn().mockResolvedValue(rewardFixture()),
      create: jest.fn().mockResolvedValue(rewardFixture()),
      update: jest.fn().mockResolvedValue(rewardFixture()),
      softDelete: jest.fn().mockResolvedValue(rewardFixture()),
    };

    media = {
      uploadImage: jest.fn(),
      deleteAsset: jest.fn().mockResolvedValue(undefined),
      cleanupOrphans: jest.fn(),
    };

    service = new RewardsService(
      repository as unknown as RewardsRepository,
      media as unknown as MediaService,
    );
  });

  const recordedFilter = () =>
    (
      repository.findMany.mock.calls[0] as [{ filter: unknown }] | undefined
    )?.[0].filter as Record<string, unknown> | undefined;

  describe('create', () => {
    it('maps the modal field names onto the columns', async () => {
      await service.create(
        createDto({
          rewardName: '  Free Coffee  ',
          termsConditions: '  One per month.  ',
          description: '   ',
          category: RewardCategory.FOOD,
          status: ItemStatus.COMING_SOON,
          stock: 12,
        }),
        undefined,
        ADMIN,
      );

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Free Coffee',
          terms: 'One per month.',
          // Whitespace-only is not a description, it is an empty field.
          description: null,
          category: RewardCategory.FOOD,
          status: ItemStatus.COMING_SOON,
          stock: 12,
          createdByAdminId: ADMIN.id,
        }),
      );
    });

    it('defaults an omitted stock to null, meaning unlimited', async () => {
      await service.create(createDto(), undefined, ADMIN);

      expect(
        (repository.create.mock.calls[0] as [{ stock: unknown }])[0].stock,
      ).toBeNull();
    });

    it.each([-1, 1.5])('rejects a stock of %s', async (stock) => {
      await expect(
        service.create(createDto({ stock }), undefined, ADMIN),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);

      expect(repository.create).not.toHaveBeenCalled();
    });

    it('accepts a stock of 0 — out of stock is not hidden', async () => {
      await service.create(createDto({ stock: 0 }), undefined, ADMIN);

      expect(
        (repository.create.mock.calls[0] as [{ stock: unknown }])[0].stock,
      ).toBe(0);
    });

    it('deletes the uploaded asset when the insert fails', async () => {
      media.uploadImage.mockResolvedValue({ id: 'asset-1' });
      repository.create.mockRejectedValue(new Error('insert failed'));

      await expect(
        service.create(
          createDto(),
          { buffer: Buffer.alloc(0), mimetype: 'image/png', size: 0 },
          ADMIN,
        ),
      ).rejects.toThrow('insert failed');

      expect(media.deleteAsset).toHaveBeenCalledWith('asset-1');
    });
  });

  describe('update', () => {
    it('replaces the icon and only then deletes the previous asset', async () => {
      repository.findById.mockResolvedValue(
        rewardFixture({ imageId: 'old-asset' }),
      );
      media.uploadImage.mockResolvedValue({ id: 'new-asset' });

      await service.update(
        REWARD_ID,
        {},
        { buffer: Buffer.alloc(0), mimetype: 'image/png', size: 0 },
        ADMIN,
      );

      expect(repository.update).toHaveBeenCalledWith(
        REWARD_ID,
        expect.objectContaining({ imageId: 'new-asset' }),
      );
      expect(media.deleteAsset).toHaveBeenCalledWith('old-asset');
      // Ordering matters: the row points at the replacement before the old file
      // is removed, so a failed update never leaves a broken image.
      expect(repository.update.mock.invocationCallOrder[0]).toBeLessThan(
        media.deleteAsset.mock.invocationCallOrder[0]!,
      );
    });

    it('404s for an unknown reward', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.update(REWARD_ID, {}, undefined, ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove', () => {
    it('soft-deletes by stamping deletedAt and leaves the image alone', async () => {
      repository.findById.mockResolvedValue(
        rewardFixture({ imageId: 'asset-1' }),
      );

      await service.remove(REWARD_ID);

      const [id, deletedAt] = repository.softDelete.mock.calls[0] as [
        string,
        Date,
      ];

      expect(id).toBe(REWARD_ID);
      expect(deletedAt).toBeInstanceOf(Date);
      // The row still references the asset, so deleting the file would leave a
      // restored reward with a broken icon.
      expect(media.deleteAsset).not.toHaveBeenCalled();
    });

    it('404s for an already soft-deleted reward', async () => {
      // findById filters on deletedAt: null, so a deleted row simply is not
      // found — DELETE twice is a 404, not a second delete.
      repository.findById.mockResolvedValue(null);

      await expect(service.remove(REWARD_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('findAll', () => {
    it('excludes soft-deleted rewards by default', async () => {
      await service.findAll(query());

      expect(recordedFilter()?.includeDeleted).toBe(false);
    });

    it('includes them when explicitly asked', async () => {
      await service.findAll(query({ includeDeleted: 'true' }));

      expect(recordedFilter()?.includeDeleted).toBe(true);
    });

    it('passes both the status and category filters through', async () => {
      await service.findAll(
        query({ status: 'ACTIVE', category: 'FOOD', search: '  spades ' }),
      );

      expect(recordedFilter()).toEqual(
        expect.objectContaining({
          status: ItemStatus.ACTIVE,
          category: RewardCategory.FOOD,
          search: 'spades',
        }),
      );
    });

    it('falls back to createdAt for a sort column outside the allowlist', async () => {
      await service.findAll(query({ sortBy: 'stock; DROP TABLE "Reward"' }));

      expect(
        (repository.findMany.mock.calls[0] as [{ sortBy: string }])[0].sortBy,
      ).toBe('createdAt');
    });
  });

  describe('serialised shape', () => {
    it('flags low stock between 1 and the threshold, but not 0', async () => {
      repository.findById.mockResolvedValue(
        rewardFixture({ stock: LOW_STOCK_THRESHOLD }),
      );
      await expect(service.findOne(REWARD_ID)).resolves.toMatchObject({
        stock: LOW_STOCK_THRESHOLD,
        isLowStock: true,
      });

      repository.findById.mockResolvedValue(rewardFixture({ stock: 0 }));
      await expect(service.findOne(REWARD_ID)).resolves.toMatchObject({
        stock: 0,
        // Out of stock is a different state from low stock, and the UI shows
        // them differently.
        isLowStock: false,
      });

      repository.findById.mockResolvedValue(rewardFixture({ stock: null }));
      await expect(service.findOne(REWARD_ID)).resolves.toMatchObject({
        stock: null,
        isLowStock: false,
      });
    });

    it('leaves `value` exactly as submitted — D-17', async () => {
      repository.findById.mockResolvedValue(
        rewardFixture({ value: '500 tokens' }),
      );

      // Not "500.00": the field mixes currency with token counts, so it is a
      // display string and never goes through formatMoney.
      await expect(service.findOne(REWARD_ID)).resolves.toMatchObject({
        value: '500 tokens',
      });
    });
  });
});

describe('reward DTO validation', () => {
  const errorsFor = (raw: Record<string, unknown>) =>
    validateSync(
      plainToInstance(
        CreateRewardDto,
        {
          rewardName: 'Free Coffee',
          company: 'Starbucks',
          value: '$10',
          ...raw,
        },
        { enableImplicitConversion: true },
      ),
    );

  it.each(Object.values(RewardCategory))('accepts the %s category', (value) => {
    expect(errorsFor({ category: value })).toHaveLength(0);
  });

  it.each(['food', 'Food', 'FOOD'])(
    'normalises the modal spelling %s',
    (value) => {
      const dto = plainToInstance(
        CreateRewardDto,
        {
          rewardName: 'Free Coffee',
          company: 'Starbucks',
          value: '$10',
          category: value,
        },
        { enableImplicitConversion: true },
      );

      expect(validateSync(dto)).toHaveLength(0);
      expect(dto.category).toBe(RewardCategory.FOOD);
    },
  );

  it.each(['SNACKS', 'DRINKS', 'FOOD; DROP TABLE "Reward"', '0'])(
    'rejects %s as a category',
    (value) => {
      const errors = errorsFor({ category: value });

      // An unchecked value would reach a Prisma enum column, so the field
      // accepts catalogue members and nothing else.
      expect(errors).not.toHaveLength(0);
      expect(errors[0]?.property).toBe('category');
    },
  );

  it.each(['', '   '])(
    'treats the empty multipart category %p as omitted',
    (value) => {
      const dto = plainToInstance(
        CreateRewardDto,
        {
          rewardName: 'Free Coffee',
          company: 'Starbucks',
          value: '$10',
          category: value,
        },
        { enableImplicitConversion: true },
      );

      // A multipart form sends "" for a select the admin never touched. That is
      // "not supplied", not "an invalid category".
      expect(validateSync(dto)).toHaveLength(0);
      expect(dto.category).toBeUndefined();
    },
  );

  it('normalises the modal status "coming-soon"', () => {
    const dto = plainToInstance(
      CreateRewardDto,
      {
        rewardName: 'Free Coffee',
        company: 'Starbucks',
        value: '$10',
        status: 'coming-soon',
      },
      { enableImplicitConversion: true },
    );

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.status).toBe(ItemStatus.COMING_SOON);
  });

  it.each([-1, -100])('rejects a negative stock of %s', (stock) => {
    const errors = errorsFor({ stock });

    expect(errors[0]?.property).toBe('stock');
  });

  it('treats an empty multipart stock field as omitted', () => {
    const dto = plainToInstance(
      CreateRewardDto,
      {
        rewardName: 'Free Coffee',
        company: 'Starbucks',
        value: '$10',
        stock: '',
      },
      { enableImplicitConversion: true },
    );

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.stock).toBeUndefined();
  });
});

describe('QueryRewardsDto', () => {
  it.each(['SNACKS', 'nope'])('rejects %s as a category filter', (value) => {
    const errors = validateSync(
      plainToInstance(
        QueryRewardsDto,
        { category: value },
        { enableImplicitConversion: true },
      ),
    );

    expect(errors[0]?.property).toBe('category');
  });

  it('reads includeDeleted=false as false, not as a truthy string', () => {
    const dto = plainToInstance(
      QueryRewardsDto,
      { includeDeleted: 'false' },
      { enableImplicitConversion: true },
    );

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.includeDeleted).toBe(false);
  });
});
