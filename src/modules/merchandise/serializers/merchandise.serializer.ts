import type { ItemStatus } from '@prisma/client';

import { isLowStock } from '../../../common/constants/stock';
import { formatMoney } from '../../../common/money/money.util';
import type {
  MerchandiseWithRelations,
  VariantRow,
} from '../repositories/merchandise.repository';

export interface MerchandiseImage {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
}

export interface MerchandiseVariantItem {
  id: string;
  merchandiseId: string;
  size: string | null;
  color: string | null;
  sku: string | null;
  stock: number;
  /** True only between 1 and the threshold; 0 is out of stock, not low stock. */
  isLowStock: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The row rendered by the merchandise grid.
 *
 * `variantCount` and `totalStock` are computed here rather than fetched as an
 * aggregate, because the variants are already in hand — and two numbers derived
 * from one array cannot disagree with it.
 *
 * `price` is a two-decimal string, never a float (docs/03-API-CONTRACT.md).
 */
export interface MerchandiseListItem {
  id: string;
  name: string;
  description: string | null;
  price: string;
  image: MerchandiseImage | null;
  status: ItemStatus;
  variantCount: number;
  totalStock: number;
  /** True when any single variant is low — that is the one to reorder. */
  isLowStock: boolean;
  variants: MerchandiseVariantItem[];
  deletedAt: Date | null;
  createdAt: Date;
}

export interface MerchandiseDetail extends MerchandiseListItem {
  createdByAdminId: string;
  updatedAt: Date;
}

export function toVariantItem(variant: VariantRow): MerchandiseVariantItem {
  return {
    id: variant.id,
    merchandiseId: variant.merchandiseId,
    size: variant.size,
    color: variant.color,
    sku: variant.sku,
    stock: variant.stock,
    isLowStock: isLowStock(variant.stock),
    createdAt: variant.createdAt,
    updatedAt: variant.updatedAt,
  };
}

export function toMerchandiseListItem(
  merchandise: MerchandiseWithRelations,
): MerchandiseListItem {
  const variants = merchandise.variants.map(toVariantItem);

  return {
    id: merchandise.id,
    name: merchandise.name,
    description: merchandise.description,
    price: formatMoney(merchandise.price),
    image: merchandise.image
      ? {
          id: merchandise.image.id,
          url: merchandise.image.url,
          width: merchandise.image.width,
          height: merchandise.image.height,
        }
      : null,
    status: merchandise.status,
    variantCount: variants.length,
    totalStock: variants.reduce((sum, variant) => sum + variant.stock, 0),
    isLowStock: variants.some((variant) => variant.isLowStock),
    variants,
    deletedAt: merchandise.deletedAt,
    createdAt: merchandise.createdAt,
  };
}

export function toMerchandiseDetail(
  merchandise: MerchandiseWithRelations,
): MerchandiseDetail {
  return {
    ...toMerchandiseListItem(merchandise),
    createdByAdminId: merchandise.createdByAdminId,
    updatedAt: merchandise.updatedAt,
  };
}
