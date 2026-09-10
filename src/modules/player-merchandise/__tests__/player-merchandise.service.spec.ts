import { Prisma, ShipmentStatus } from '@prisma/client';

import { PlayerMerchandiseService } from '../player-merchandise.service';
import type { PlayerMerchandiseRepository } from '../repositories/player-merchandise.repository';

const dto = {
  merchandiseId: '44444444-4444-4444-8444-000000000001',
  variantId: '55555555-5555-4555-8555-000000000001',
  requestId: '77777777-7777-4777-8777-000000000001',
  shippingName: ' John Doe ',
  addressLine1: ' 123 Main St ',
  addressLine2: '',
  city: ' New York ',
  state: ' NY ',
  postalCode: ' 10001 ',
  country: ' United States ',
};

const shipment = {
  id: '66666666-6666-4666-8666-000000000001',
  userId: '11111111-1111-4111-8111-111111111111',
  merchandiseId: dto.merchandiseId,
  variantId: dto.variantId,
  customisation: null,
  requestId: dto.requestId,
  payloadHash: '',
  tokenCost: new Prisma.Decimal('200'),
  purchaseTransactionId: '88888888-8888-4888-8888-000000000001',
  refundTransactionId: null,
  shippingName: 'John Doe',
  addressLine1: '123 Main St',
  addressLine2: null,
  city: 'New York',
  state: 'NY',
  postalCode: '10001',
  country: 'United States',
  status: ShipmentStatus.PENDING,
  carrier: null,
  trackingNumber: null,
  shippedAt: null,
  deliveredAt: null,
  cancelledAt: null,
  createdByAdminId: null,
  createdAt: new Date('2026-09-09T00:00:00Z'),
  updatedAt: new Date('2026-09-09T00:00:00Z'),
  merchandise: {
    id: dto.merchandiseId,
    name: 'Team Jersey',
    description: null,
    price: new Prisma.Decimal('39.95'),
    tokenCost: new Prisma.Decimal('200'),
    imageId: null,
    image: null,
    status: 'ACTIVE' as const,
    createdByAdminId: '99999999-9999-4999-8999-000000000001',
    deletedAt: null,
    createdAt: new Date('2026-09-09T00:00:00Z'),
    updatedAt: new Date('2026-09-09T00:00:00Z'),
  },
  variant: {
    id: dto.variantId,
    merchandiseId: dto.merchandiseId,
    size: 'M',
    color: 'Black',
    sku: 'TEAM-M-BLACK',
    stock: 2,
    position: 0,
    createdAt: new Date('2026-09-09T00:00:00Z'),
    updatedAt: new Date('2026-09-09T00:00:00Z'),
  },
};

describe('PlayerMerchandiseService', () => {
  const repository = {
    listCatalog: jest.fn(),
    listOwned: jest.fn(),
    findOwned: jest.fn(),
    create: jest.fn(),
    cancelOwned: jest.fn(),
  };
  const service = new PlayerMerchandiseService(
    repository as unknown as PlayerMerchandiseRepository,
  );

  beforeEach(() => jest.clearAllMocks());

  it('normalizes the address and returns a durable claim', async () => {
    repository.create.mockResolvedValue({
      outcome: 'CREATED',
      shipment,
    });

    const result = await service.create('player-1', dto);

    expect(result.address).toEqual({
      shippingName: 'John Doe',
      addressLine1: '123 Main St',
      addressLine2: null,
      city: 'New York',
      state: 'NY',
      postalCode: '10001',
      country: 'United States',
    });
    expect(repository.create).toHaveBeenCalledWith(
      'player-1',
      expect.objectContaining({ shippingName: 'John Doe' }),
    );
  });

  it.each([
    ['PRODUCT_UNAVAILABLE', 'no longer available'],
    ['VARIANT_MISMATCH', 'does not belong'],
    ['PLAYER_NOT_FOUND', 'Player not found'],
  ] as const)('maps %s to a safe API error', async (outcome, message) => {
    repository.create.mockResolvedValue({ outcome });
    await expect(service.create('player-1', dto)).rejects.toThrow(message);
  });

  it('reports the authoritative balance on insufficient funds', async () => {
    repository.create.mockResolvedValue({
      outcome: 'INSUFFICIENT_BALANCE',
      balance: new Prisma.Decimal('12.50'),
    });
    await expect(service.create('player-1', dto)).rejects.toThrow(
      'Available: 12.50 tokens',
    );
  });

  it('rejects an idempotency key reused for a changed payload', async () => {
    repository.create.mockResolvedValue({
      outcome: 'EXISTING',
      shipment: { ...shipment, payloadHash: 'different' },
    });
    await expect(service.create('player-1', dto)).rejects.toThrow(
      'already used for a different merchandise claim',
    );
  });

  it('cancels an owned pending shipment', async () => {
    repository.cancelOwned.mockResolvedValue({
      ...shipment,
      status: ShipmentStatus.CANCELLED,
    });
    await expect(service.cancel('player-1', shipment.id)).resolves.toEqual(
      expect.objectContaining({ status: 'CANCELLED' }),
    );
  });
});
