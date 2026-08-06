import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ItemStatus, Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { LOW_STOCK_THRESHOLD } from '../../../common/constants/stock';
import type { AuthenticatedAdmin } from '../../auth/interfaces/authenticated-admin.interface';
import type { MediaService } from '../../storage/media.service';
import { CreateMerchandiseDto } from '../dto/create-merchandise.dto';
import { QueryMerchandiseDto } from '../dto/query-merchandise.dto';
import { CreateVariantDto } from '../dto/variant.dto';
import { MerchandiseService } from '../merchandise.service';
import type {
  MerchandiseRepository,
  MerchandiseWithRelations,
  VariantInput,
  VariantRow,
} from '../repositories/merchandise.repository';
import { disambiguateSku, generateSku } from '../sku.util';

type MockedMerchandise = { [K in keyof MerchandiseRepository]: jest.Mock };
type MockedMedia = { [K in keyof MediaService]: jest.Mock };

const ADMIN: AuthenticatedAdmin = {
  id: 'admin-1',
  email: 'admin@bjspades.com',
  role: 'SUPER_ADMIN',
  roleId: 'role-1',
  sessionId: 'session-1',
};

const MERCH_ID = '44444444-4444-4444-8444-000000000001';
const VARIANT_ID = '55555555-5555-4555-8555-000000000001';

function variantFixture(overrides: Partial<VariantRow> = {}): VariantRow {
  return {
    id: VARIANT_ID,
    merchandiseId: MERCH_ID,
    size: 'L',
    color: 'Black',
    sku: 'MERCH-4444-L-BLACK',
    stock: 10,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

function merchandiseFixture(
  overrides: Partial<MerchandiseWithRelations> = {},
): MerchandiseWithRelations {
  return {
    id: MERCH_ID,
    name: 'Team Jersey',
    description: null,
    price: new Prisma.Decimal('39.95'),
    imageId: null,
    image: null,
    status: ItemStatus.ACTIVE,
    variants: [variantFixture()],
    createdByAdminId: ADMIN.id,
    deletedAt: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

function createDto(
  overrides: Record<string, unknown> = {},
): CreateMerchandiseDto {
  return plainToInstance(
    CreateMerchandiseDto,
    { productName: 'Team Jersey', price: '39.95', ...overrides },
    { enableImplicitConversion: true },
  );
}

function query(raw: Record<string, unknown> = {}): QueryMerchandiseDto {
  return plainToInstance(QueryMerchandiseDto, raw, {
    enableImplicitConversion: true,
  });
}

describe('SKU generation', () => {
  it('builds MERCH-{id prefix}-{SIZE}-{COLOR}', () => {
    expect(
      generateSku('a3f2b1c0-0000-4000-8000-000000000000', 'L', 'Black'),
    ).toBe('MERCH-A3F2-L-BLACK');
  });

  it('is deterministic — the same inputs always give the same SKU', () => {
    const first = generateSku(MERCH_ID, 'XL', 'Navy Blue');
    const second = generateSku(MERCH_ID, 'XL', 'Navy Blue');

    expect(first).toBe(second);
    // Spaces and punctuation are stripped: a SKU travels through URLs and CSVs.
    expect(first).toBe('MERCH-4444-XL-NAVYBLUE');
  });

  it('omits the segment for an absent size or colour', () => {
    expect(generateSku(MERCH_ID, null, 'Red')).toBe('MERCH-4444-RED');
    expect(generateSku(MERCH_ID, 'S', null)).toBe('MERCH-4444-S');
    expect(generateSku(MERCH_ID, null, null)).toBe('MERCH-4444');
  });

  it('disambiguates against SKUs already taken', () => {
    const base = generateSku(MERCH_ID, null, null);

    expect(disambiguateSku(base, new Set())).toBe(base);
    expect(disambiguateSku(base, new Set([base]))).toBe(`${base}-2`);
    expect(disambiguateSku(base, new Set([base, `${base}-2`]))).toBe(
      `${base}-3`,
    );
  });
});

describe('MerchandiseService', () => {
  let repository: MockedMerchandise;
  let media: MockedMedia;
  let service: MerchandiseService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findById: jest.fn().mockResolvedValue(merchandiseFixture()),
      createWithVariants: jest.fn().mockResolvedValue({
        outcome: 'OK',
        merchandise: merchandiseFixture(),
      }),
      update: jest.fn().mockResolvedValue(merchandiseFixture()),
      softDelete: jest.fn().mockResolvedValue(merchandiseFixture()),
      findVariant: jest.fn().mockResolvedValue(variantFixture()),
      findVariantSkus: jest.fn().mockResolvedValue([]),
      createVariant: jest
        .fn()
        .mockResolvedValue({ outcome: 'OK', variant: variantFixture() }),
      updateVariant: jest
        .fn()
        .mockResolvedValue({ outcome: 'OK', variant: variantFixture() }),
      deleteVariant: jest.fn().mockResolvedValue(undefined),
    };

    media = {
      uploadImage: jest.fn(),
      deleteAsset: jest.fn().mockResolvedValue(undefined),
      cleanupOrphans: jest.fn(),
    };

    service = new MerchandiseService(
      repository as unknown as MerchandiseRepository,
      media as unknown as MediaService,
    );
  });

  const submittedVariants = (): VariantInput[] =>
    (
      repository.createWithVariants.mock.calls[0] as [unknown, VariantInput[]]
    )[1];

  describe('create with variants', () => {
    it('creates every submitted variant, in one call', async () => {
      await service.create(
        createDto({
          variants: [
            { size: 'S', color: 'Black', stock: 4 },
            { size: 'M', color: 'Black', stock: 0 },
            { size: 'L', color: 'White', stock: 12 },
          ],
        }),
        undefined,
        ADMIN,
      );

      // One call, three rows — the repository writes them in a single
      // transaction, so a partial set cannot be committed.
      expect(repository.createWithVariants).toHaveBeenCalledTimes(1);
      expect(submittedVariants()).toHaveLength(3);
      expect(submittedVariants().map((variant) => variant.size)).toEqual([
        'S',
        'M',
        'L',
      ]);
      expect(submittedVariants().map((variant) => variant.stock)).toEqual([
        4, 0, 12,
      ]);
    });

    it('auto-generates a SKU for every variant that omits one', async () => {
      await service.create(
        createDto({
          variants: [
            { size: 'L', color: 'Black' },
            { size: 'L', color: 'White' },
          ],
        }),
        undefined,
        ADMIN,
      );

      const [id] = repository.createWithVariants.mock.calls[0] as [
        { id: string },
      ];
      const skus = submittedVariants().map((variant) => variant.sku);

      expect(skus).toEqual([
        generateSku(id.id, 'L', 'Black'),
        generateSku(id.id, 'L', 'White'),
      ]);
      expect(new Set(skus).size).toBe(2);
    });

    it('keeps generated SKUs unique when two variants are identical', async () => {
      await service.create(
        createDto({ variants: [{ size: 'L' }, { size: 'L' }, { size: 'L' }] }),
        undefined,
        ADMIN,
      );

      const skus = submittedVariants().map((variant) => variant.sku);

      // Three identical variants must not produce one SKU three times — the
      // second insert would violate the unique index and roll the product back.
      expect(new Set(skus).size).toBe(3);
      expect(skus[1]).toBe(`${skus[0]!}-2`);
      expect(skus[2]).toBe(`${skus[0]!}-3`);
    });

    it('uses a supplied SKU verbatim, upper-cased', async () => {
      await service.create(
        createDto({ variants: [{ size: 'L', sku: 'JERSEY-L-01' }] }),
        undefined,
        ADMIN,
      );

      expect(submittedVariants()[0]?.sku).toBe('JERSEY-L-01');
    });

    it('throws Conflict when two submitted variants share a SKU', async () => {
      await expect(
        service.create(
          createDto({
            variants: [
              { size: 'S', sku: 'JERSEY-01' },
              { size: 'M', sku: 'JERSEY-01' },
            ],
          }),
          undefined,
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(repository.createWithVariants).not.toHaveBeenCalled();
    });

    it('throws Conflict when the database reports a duplicate SKU', async () => {
      repository.createWithVariants.mockResolvedValue({
        outcome: 'DUPLICATE_SKU',
        sku: 'JERSEY-01',
      });

      await expect(
        service.create(
          createDto({ variants: [{ size: 'S', sku: 'JERSEY-01' }] }),
          undefined,
          ADMIN,
        ),
      ).rejects.toThrow(/JERSEY-01/);
    });

    it('removes the uploaded image when the transaction rolls back', async () => {
      media.uploadImage.mockResolvedValue({ id: 'asset-1' });
      repository.createWithVariants.mockResolvedValue({
        outcome: 'DUPLICATE_SKU',
        sku: 'JERSEY-01',
      });

      await expect(
        service.create(
          createDto({ variants: [{ sku: 'JERSEY-01' }] }),
          { buffer: Buffer.alloc(0), mimetype: 'image/png', size: 0 },
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      // The product no longer exists, so nothing references the file.
      expect(media.deleteAsset).toHaveBeenCalledWith('asset-1');
    });

    it.each([-1, 2.5])('rejects a variant stock of %s', async (stock) => {
      await expect(
        service.create(
          createDto({ variants: [{ size: 'L', stock }] }),
          undefined,
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);

      expect(repository.createWithVariants).not.toHaveBeenCalled();
    });

    it('defaults an omitted stock to 0 — out of stock, not hidden', async () => {
      await service.create(
        createDto({ variants: [{ size: 'L' }] }),
        undefined,
        ADMIN,
      );

      expect(submittedVariants()[0]?.stock).toBe(0);
    });
  });

  describe('price', () => {
    it.each(['-1.00', '-0.01'])(
      'rejects the negative price %s',
      async (price) => {
        await expect(
          service.create(createDto({ price }), undefined, ADMIN),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
      },
    );

    it.each(['19.999', '0.001', '1.2345'])(
      'rejects %s for having more than two decimals',
      async (price) => {
        // NUMERIC(18,2) would round rather than refuse, so the client would
        // never learn its price had changed.
        await expect(
          service.create(createDto({ price }), undefined, ADMIN),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
      },
    );

    it('stores a valid price as a Decimal, not a float', async () => {
      await service.create(createDto({ price: '39.95' }), undefined, ADMIN);

      const [data] = repository.createWithVariants.mock.calls[0] as [
        { price: Prisma.Decimal },
      ];

      expect(data.price).toBeInstanceOf(Prisma.Decimal);
      expect(data.price.toFixed(2)).toBe('39.95');
    });

    it('serialises the price back out as a two-decimal string', async () => {
      repository.findById.mockResolvedValue(
        merchandiseFixture({ price: new Prisma.Decimal('40') }),
      );

      await expect(service.findOne(MERCH_ID)).resolves.toMatchObject({
        price: '40.00',
      });
    });
  });

  describe('soft delete', () => {
    it('stamps deletedAt rather than removing the row', async () => {
      await service.remove(MERCH_ID);

      const [id, deletedAt] = repository.softDelete.mock.calls[0] as [
        string,
        Date,
      ];

      expect(id).toBe(MERCH_ID);
      expect(deletedAt).toBeInstanceOf(Date);
      expect(media.deleteAsset).not.toHaveBeenCalled();
    });

    it('excludes soft-deleted products from the default listing', async () => {
      await service.findAll(query());

      expect(
        (
          repository.findMany.mock.calls[0] as [
            { filter: Record<string, unknown> },
          ]
        )[0].filter.includeDeleted,
      ).toBe(false);
    });

    it('includes them when explicitly asked', async () => {
      await service.findAll(query({ includeDeleted: 'true' }));

      expect(
        (
          repository.findMany.mock.calls[0] as [
            { filter: Record<string, unknown> },
          ]
        )[0].filter.includeDeleted,
      ).toBe(true);
    });

    it('404s a product that is already soft-deleted', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.remove(MERCH_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('variants', () => {
    it('generates a SKU that avoids the ones the product already uses', async () => {
      const base = generateSku(MERCH_ID, 'L', 'Black');
      repository.findVariantSkus.mockResolvedValue([base]);

      await service.addVariant(
        MERCH_ID,
        plainToInstance(CreateVariantDto, { size: 'L', color: 'Black' }),
      );

      const [, variant] = repository.createVariant.mock.calls[0] as [
        string,
        VariantInput,
      ];

      expect(variant.sku).toBe(`${base}-2`);
    });

    it('throws Conflict for a supplied SKU the product already uses', async () => {
      repository.findVariantSkus.mockResolvedValue(['JERSEY-01']);

      await expect(
        service.addVariant(
          MERCH_ID,
          plainToInstance(CreateVariantDto, { sku: 'JERSEY-01' }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('404s a variant belonging to another product', async () => {
      repository.findVariant.mockResolvedValue(null);

      await expect(
        service.updateVariant(MERCH_ID, VARIANT_ID, { stock: 1 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.removeVariant(MERCH_ID, VARIANT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a negative stock on update', async () => {
      await expect(
        service.updateVariant(MERCH_ID, VARIANT_ID, { stock: -5 }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);

      expect(repository.updateVariant).not.toHaveBeenCalled();
    });

    it('returns the removed variant so the audit entry can name its SKU', async () => {
      const removed = variantFixture({ sku: 'MERCH-4444-XL-RED' });
      repository.findVariant.mockResolvedValue(removed);

      await expect(
        service.removeVariant(MERCH_ID, VARIANT_ID),
      ).resolves.toMatchObject({ sku: 'MERCH-4444-XL-RED' });
      expect(repository.deleteVariant).toHaveBeenCalledWith(VARIANT_ID);
    });
  });

  describe('serialised shape', () => {
    it('reports variantCount, totalStock and the low-stock flag', async () => {
      repository.findById.mockResolvedValue(
        merchandiseFixture({
          variants: [
            variantFixture({ id: 'v1', stock: 20 }),
            variantFixture({ id: 'v2', stock: LOW_STOCK_THRESHOLD }),
            variantFixture({ id: 'v3', stock: 0 }),
          ],
        }),
      );

      const detail = await service.findOne(MERCH_ID);

      expect(detail.variantCount).toBe(3);
      expect(detail.totalStock).toBe(25);
      // One variant is low, which is the one somebody has to reorder.
      expect(detail.isLowStock).toBe(true);
      expect(detail.variants.map((variant) => variant.isLowStock)).toEqual([
        false,
        true,
        // 0 is out of stock, a different state the UI shows differently.
        false,
      ]);
    });
  });

  describe('sorting', () => {
    it('falls back to createdAt for a column outside the allowlist', async () => {
      await service.findAll(query({ sortBy: 'price); DROP TABLE x --' }));

      expect(
        (repository.findMany.mock.calls[0] as [{ sortBy: string }])[0].sortBy,
      ).toBe('createdAt');
    });
  });
});

describe('CreateMerchandiseDto', () => {
  const build = (raw: Record<string, unknown>) =>
    plainToInstance(
      CreateMerchandiseDto,
      { productName: 'Team Jersey', price: '39.95', ...raw },
      { enableImplicitConversion: true },
    );

  it('parses a multipart JSON variants string into validated instances', () => {
    const dto = build({
      variants: '[{"size":"L","color":"Black","stock":"7"}]',
    });

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.variants?.[0]).toBeInstanceOf(CreateVariantDto);
    expect(dto.variants?.[0]?.stock).toBe(7);
  });

  it('flags a nested constraint violation inside a multipart variants string', () => {
    const errors = validateSync(build({ variants: '[{"stock":-3}]' }));

    // Proof the nested DTO is really being validated: a plain parsed object
    // would carry no constraints and would pass silently.
    expect(errors[0]?.property).toBe('variants');
    expect(JSON.stringify(errors)).toMatch(/stock/);
  });

  it.each(['not json', '{"size":"L"}', '[1,2]'])(
    'rejects %p as a variants payload',
    (variants) => {
      expect(() => build({ variants })).toThrow();
    },
  );

  it.each(['-1.00', '19.999', 'free', '1e3'])(
    'rejects %s as a price',
    (price) => {
      const errors = validateSync(build({ price }));

      expect(errors[0]?.property).toBe('price');
    },
  );

  it('normalises the modal status "coming-soon"', () => {
    const dto = build({ status: 'coming-soon' });

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.status).toBe(ItemStatus.COMING_SOON);
  });
});
