import { Injectable } from '@nestjs/common';
import { ItemStatus, Prisma } from '@prisma/client';

import type { Money } from '../../../common/money/money.util';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Variants travel with every read of a product.
 *
 * The list needs `variantCount` and `totalStock`, and the detail view needs the
 * rows themselves for the variant editor. A product has a handful of variants,
 * so fetching them is cheaper than a second round trip plus an aggregate — and
 * it removes the possibility of the count and the rows disagreeing.
 *
 * Ordered by creation: the variant editor shows them in the order they were
 * added, and a stable order is what makes "creates 3 variants" assertable.
 */
const MERCHANDISE_INCLUDE = {
  image: true,
  variants: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.MerchandiseInclude;

export type MerchandiseWithRelations = Prisma.MerchandiseGetPayload<{
  include: typeof MERCHANDISE_INCLUDE;
}>;

export type VariantRow = Prisma.MerchandiseVariantGetPayload<object>;

/** Expressed in domain terms; translating to Prisma is this class's job. */
export interface MerchandiseFilter {
  search?: string;
  status?: ItemStatus;
  /** Off by default — soft-deleted products are not part of the catalogue. */
  includeDeleted?: boolean;
}

export interface ListMerchandiseArgs {
  filter: MerchandiseFilter;
  /** Already checked against an allowlist by the service. */
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  skip: number;
  take: number;
}

export interface CreateMerchandiseData {
  /**
   * Supplied by the service rather than defaulted by the database.
   *
   * A generated SKU embeds the product id, and the SKUs have to be known before
   * the transaction that writes them. Choosing the id up front is what lets SKU
   * policy live in the service instead of leaking into this class.
   */
  id: string;
  name: string;
  description: string | null;
  price: Money;
  imageId: string | null;
  status: ItemStatus;
  createdByAdminId: string;
}

export interface UpdateMerchandiseData {
  name?: string;
  description?: string | null;
  price?: Money;
  imageId?: string | null;
  status?: ItemStatus;
}

export interface VariantInput {
  size: string | null;
  color: string | null;
  sku: string;
  stock: number;
}

export interface UpdateVariantData {
  size?: string | null;
  color?: string | null;
  sku?: string;
  stock?: number;
}

/**
 * Every way a write that touches a SKU can end.
 *
 * A discriminated union rather than thrown HTTP exceptions: the repository knows
 * what the database said, the service owns which status code that maps to. That
 * split is what keeps NestJS types out of the data layer.
 */
export type MerchandiseWriteOutcome =
  | { outcome: 'OK'; merchandise: MerchandiseWithRelations }
  | { outcome: 'DUPLICATE_SKU'; sku: string };

export type VariantWriteOutcome =
  | { outcome: 'OK'; variant: VariantRow }
  | { outcome: 'DUPLICATE_SKU'; sku: string };

/** Duck-typed for the same reason AllExceptionsFilter is: the client is generated. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

/**
 * Carries the offending SKU out of the transaction callback.
 *
 * Thrown rather than returned because throwing is what rolls the transaction
 * back — returning a value would commit the product and the variants written
 * before the clash.
 */
class SkuConflictError extends Error {
  constructor(readonly sku: string) {
    super(`SKU ${sku} is already taken`);
    this.name = 'SkuConflictError';
  }
}

@Injectable()
export class MerchandiseRepository {
  constructor(private readonly prisma: PrismaService) {}

  private buildWhere(filter: MerchandiseFilter): Prisma.MerchandiseWhereInput {
    const where: Prisma.MerchandiseWhereInput = {};

    if (!filter.includeDeleted) {
      where.deletedAt = null;
    }

    if (filter.status) {
      where.status = filter.status;
    }

    if (filter.search) {
      where.name = { contains: filter.search, mode: 'insensitive' };
    }

    return where;
  }

  findMany(args: ListMerchandiseArgs): Promise<MerchandiseWithRelations[]> {
    return this.prisma.merchandise.findMany({
      where: this.buildWhere(args.filter),
      include: MERCHANDISE_INCLUDE,
      // The id tiebreak keeps paging stable when the sort column has ties.
      orderBy: [{ [args.sortBy]: args.sortOrder }, { id: 'asc' }],
      skip: args.skip,
      take: args.take,
    });
  }

  count(filter: MerchandiseFilter): Promise<number> {
    return this.prisma.merchandise.count({ where: this.buildWhere(filter) });
  }

  findById(
    id: string,
    includeDeleted = false,
  ): Promise<MerchandiseWithRelations | null> {
    return this.prisma.merchandise.findFirst({
      where: includeDeleted ? { id } : { id, deletedAt: null },
      include: MERCHANDISE_INCLUDE,
    });
  }

  /**
   * Writes the product and every variant, or neither.
   *
   * One interactive transaction, and the variants are inserted one at a time
   * rather than with `createMany`, so a clash on the third variant aborts the
   * whole thing — the product included. A partially written variant set is a
   * silent data-integrity failure: the product looks fine, and only a customer
   * who cannot find their size ever notices.
   *
   * Supplied SKUs are NOT pre-checked against the table. A read-then-write check
   * is a race that two concurrent requests can both pass; the unique index is
   * the only thing that actually decides, so it is what we let decide.
   */
  async createWithVariants(
    data: CreateMerchandiseData,
    variants: VariantInput[],
  ): Promise<MerchandiseWriteOutcome> {
    try {
      const merchandise = await this.prisma.$transaction(async (tx) => {
        const created = await tx.merchandise.create({ data });

        for (const variant of variants) {
          try {
            await tx.merchandiseVariant.create({
              data: { merchandiseId: created.id, ...variant },
            });
          } catch (error) {
            if (isUniqueViolation(error)) {
              throw new SkuConflictError(variant.sku);
            }

            throw error;
          }
        }

        return tx.merchandise.findUniqueOrThrow({
          where: { id: created.id },
          include: MERCHANDISE_INCLUDE,
        });
      });

      return { outcome: 'OK', merchandise };
    } catch (error) {
      if (error instanceof SkuConflictError) {
        return { outcome: 'DUPLICATE_SKU', sku: error.sku };
      }

      throw error;
    }
  }

  update(
    id: string,
    data: UpdateMerchandiseData,
  ): Promise<MerchandiseWithRelations> {
    return this.prisma.merchandise.update({
      where: { id },
      data,
      include: MERCHANDISE_INCLUDE,
    });
  }

  /**
   * Soft delete. The variants are left in place: a hard delete would cascade
   * and take the SKUs with it, and the row survives precisely so an order
   * placed in Milestone 2 can still name what was bought.
   */
  softDelete(id: string, deletedAt: Date): Promise<MerchandiseWithRelations> {
    return this.prisma.merchandise.update({
      where: { id },
      data: { deletedAt },
      include: MERCHANDISE_INCLUDE,
    });
  }

  findVariant(
    merchandiseId: string,
    variantId: string,
  ): Promise<VariantRow | null> {
    // Both ids in the predicate, so a variant id belonging to another product
    // 404s instead of being edited through the wrong parent's URL.
    return this.prisma.merchandiseVariant.findFirst({
      where: { id: variantId, merchandiseId },
    });
  }

  /** SKUs already used by this product, so a generated one can avoid them. */
  async findVariantSkus(merchandiseId: string): Promise<string[]> {
    const rows = await this.prisma.merchandiseVariant.findMany({
      where: { merchandiseId },
      select: { sku: true },
    });

    return rows
      .map((row) => row.sku)
      .filter((sku): sku is string => sku !== null);
  }

  async createVariant(
    merchandiseId: string,
    variant: VariantInput,
  ): Promise<VariantWriteOutcome> {
    try {
      return {
        outcome: 'OK',
        variant: await this.prisma.merchandiseVariant.create({
          data: { merchandiseId, ...variant },
        }),
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { outcome: 'DUPLICATE_SKU', sku: variant.sku };
      }

      throw error;
    }
  }

  async updateVariant(
    variantId: string,
    data: UpdateVariantData,
  ): Promise<VariantWriteOutcome> {
    try {
      return {
        outcome: 'OK',
        variant: await this.prisma.merchandiseVariant.update({
          where: { id: variantId },
          data,
        }),
      };
    } catch (error) {
      if (isUniqueViolation(error) && data.sku) {
        return { outcome: 'DUPLICATE_SKU', sku: data.sku };
      }

      throw error;
    }
  }

  async deleteVariant(variantId: string): Promise<void> {
    await this.prisma.merchandiseVariant.delete({ where: { id: variantId } });
  }
}
