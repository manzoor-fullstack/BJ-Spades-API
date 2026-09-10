import type { Prisma } from '@prisma/client';

import { formatMoney } from '../../common/money/money.util';
import type {
  PLAYER_MERCHANDISE_INCLUDE,
  PLAYER_SHIPMENT_INCLUDE,
} from './repositories/player-merchandise.repository';

type CatalogRow = Prisma.MerchandiseGetPayload<{
  include: typeof PLAYER_MERCHANDISE_INCLUDE;
}>;

export type PlayerShipmentRow = Prisma.ShipmentGetPayload<{
  include: typeof PLAYER_SHIPMENT_INCLUDE;
}>;

export function toPlayerMerchandise(row: CatalogRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: formatMoney(row.price),
    tokenCost: formatMoney(row.tokenCost),
    imageUrl: row.image?.url ?? null,
    totalStock: row.variants.reduce((sum, variant) => sum + variant.stock, 0),
    variants: row.variants.map((variant) => ({
      id: variant.id,
      size: variant.size,
      color: variant.color,
      sku: variant.sku,
      stock: variant.stock,
    })),
  };
}

export function toPlayerShipment(row: PlayerShipmentRow) {
  return {
    id: row.id,
    status: row.status,
    tokenCost: formatMoney(row.tokenCost),
    merchandise: {
      id: row.merchandise.id,
      name: row.merchandise.name,
      imageUrl: row.merchandise.image?.url ?? null,
    },
    variant: row.variant
      ? {
          id: row.variant.id,
          size: row.variant.size,
          color: row.variant.color,
          sku: row.variant.sku,
        }
      : null,
    address: {
      shippingName: row.shippingName,
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      city: row.city,
      state: row.state,
      postalCode: row.postalCode,
      country: row.country,
    },
    carrier: row.carrier,
    trackingNumber: row.trackingNumber,
    shippedAt: row.shippedAt,
    deliveredAt: row.deliveredAt,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
