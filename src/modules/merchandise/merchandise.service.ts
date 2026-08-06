import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ItemStatus } from '@prisma/client';

import {
  buildPaginationMeta,
  resolveSortField,
  SortOrder,
} from '../../common/dto/pagination.dto';
import type { Paginated } from '../../common/interceptors/transform.interceptor';
import { isValidMoneyString, toMoney } from '../../common/money/money.util';
import type { Money } from '../../common/money/money.util';
import type { AuthenticatedAdmin } from '../auth/interfaces/authenticated-admin.interface';
import type { ValidatableUpload } from '../storage/image-validation';
import { MediaService } from '../storage/media.service';

import { CreateMerchandiseDto } from './dto/create-merchandise.dto';
import { QueryMerchandiseDto } from './dto/query-merchandise.dto';
import { UpdateMerchandiseDto } from './dto/update-merchandise.dto';
import {
  CreateVariantDto,
  MAX_VARIANT_STOCK,
  UpdateVariantDto,
} from './dto/variant.dto';
import { MerchandiseRepository } from './repositories/merchandise.repository';
import type {
  CreateMerchandiseData,
  ListMerchandiseArgs,
  MerchandiseWithRelations,
  UpdateMerchandiseData,
  UpdateVariantData,
  VariantInput,
} from './repositories/merchandise.repository';
import {
  toMerchandiseDetail,
  toMerchandiseListItem,
  toVariantItem,
} from './serializers/merchandise.serializer';
import type {
  MerchandiseDetail,
  MerchandiseListItem,
  MerchandiseVariantItem,
} from './serializers/merchandise.serializer';
import { disambiguateSku, generateSku } from './sku.util';

/**
 * Columns a client may sort by. `sortBy` reaches Prisma as an object key, so an
 * unfiltered value both widens the injection surface and exposes columns that
 * were never meant to be orderable.
 */
const SORTABLE_FIELDS = [
  'createdAt',
  'updatedAt',
  'name',
  'price',
  'status',
] as const;

const DEFAULT_SORT_FIELD = 'createdAt';

/** Storage folder for product photos; also the URL path segment. */
export const MERCHANDISE_IMAGE_FOLDER = 'merchandise';

function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

@Injectable()
export class MerchandiseService {
  constructor(
    private readonly repository: MerchandiseRepository,
    private readonly media: MediaService,
  ) {}

  async findAll(
    query: QueryMerchandiseDto,
  ): Promise<Paginated<MerchandiseListItem[]>> {
    const args = this.buildListArgs(query);

    const [merchandise, total] = await Promise.all([
      this.repository.findMany(args),
      this.repository.count(args.filter),
    ]);

    return {
      data: merchandise.map(toMerchandiseListItem),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async findOne(id: string): Promise<MerchandiseDetail> {
    return toMerchandiseDetail(await this.getOrThrow(id));
  }

  async create(
    dto: CreateMerchandiseDto,
    image: ValidatableUpload | undefined,
    admin: AuthenticatedAdmin,
  ): Promise<MerchandiseDetail> {
    const price = assertPrice(dto.price);

    // The id is chosen here, not by the database default, because a generated
    // SKU embeds it and the SKUs must exist before the transaction opens.
    const id = randomUUID();

    const variants = this.resolveVariants(id, dto.variants ?? [], []);

    const asset = image
      ? await this.media.uploadImage(image, MERCHANDISE_IMAGE_FOLDER, admin.id)
      : null;

    const data: CreateMerchandiseData = {
      id,
      name: dto.productName.trim(),
      description: emptyToNull(dto.description),
      price,
      imageId: asset?.id ?? null,
      status: dto.status ?? ItemStatus.ACTIVE,
      createdByAdminId: admin.id,
    };

    let result;

    try {
      result = await this.repository.createWithVariants(data, variants);
    } catch (error) {
      // The asset was written before the row that references it, so a failed
      // insert would leave a file nothing points at.
      await this.media.deleteAsset(asset?.id);
      throw error;
    }

    if (result.outcome === 'DUPLICATE_SKU') {
      // The transaction rolled back, so the product does not exist and its
      // image now references nothing.
      await this.media.deleteAsset(asset?.id);

      throw new ConflictException(
        `SKU ${result.sku} is already in use by another variant.`,
      );
    }

    return toMerchandiseDetail(result.merchandise);
  }

  async update(
    id: string,
    dto: UpdateMerchandiseDto,
    image: ValidatableUpload | undefined,
    admin: AuthenticatedAdmin,
  ): Promise<MerchandiseDetail> {
    const existing = await this.getOrThrow(id);

    const data: UpdateMerchandiseData = {};

    if (dto.productName !== undefined) {
      data.name = dto.productName.trim();
    }

    if (dto.description !== undefined) {
      data.description = emptyToNull(dto.description);
    }

    if (dto.price !== undefined) {
      data.price = assertPrice(dto.price);
    }

    if (dto.status !== undefined) {
      data.status = dto.status;
    }

    // Uploaded before the update so a rejected image never half-applies the
    // rest of the form.
    const asset = image
      ? await this.media.uploadImage(image, MERCHANDISE_IMAGE_FOLDER, admin.id)
      : null;

    if (asset) {
      data.imageId = asset.id;
    }

    let updated: MerchandiseWithRelations;

    try {
      updated = await this.repository.update(id, data);
    } catch (error) {
      await this.media.deleteAsset(asset?.id);
      throw error;
    }

    if (asset && existing.imageId) {
      // Only once the row points at the replacement: deleting first would leave
      // a broken image if the update failed.
      await this.media.deleteAsset(existing.imageId);
    }

    return toMerchandiseDetail(updated);
  }

  /**
   * Soft delete. Returns the deleted product even though the route answers 204 —
   * Nest discards the body but the value still reaches AuditInterceptor, which
   * is what lets the audit entry name the product instead of a bare UUID.
   *
   * The image is deliberately NOT deleted: the row still references it, and
   * MediaRepository.findOrphans counts a soft-deleted product as a reference.
   */
  async remove(id: string): Promise<MerchandiseDetail> {
    await this.getOrThrow(id);

    return toMerchandiseDetail(
      await this.repository.softDelete(id, new Date()),
    );
  }

  async addVariant(
    merchandiseId: string,
    dto: CreateVariantDto,
  ): Promise<MerchandiseVariantItem> {
    await this.getOrThrow(merchandiseId);

    const existingSkus = await this.repository.findVariantSkus(merchandiseId);
    const [variant] = this.resolveVariants(merchandiseId, [dto], existingSkus);

    if (!variant) {
      // Unreachable: resolveVariants returns one row per input.
      throw new UnprocessableEntityException('No variant supplied.');
    }

    const result = await this.repository.createVariant(merchandiseId, variant);

    if (result.outcome === 'DUPLICATE_SKU') {
      throw new ConflictException(
        `SKU ${result.sku} is already in use by another variant.`,
      );
    }

    return toVariantItem(result.variant);
  }

  async updateVariant(
    merchandiseId: string,
    variantId: string,
    dto: UpdateVariantDto,
  ): Promise<MerchandiseVariantItem> {
    await this.getOrThrow(merchandiseId);

    const existing = await this.repository.findVariant(
      merchandiseId,
      variantId,
    );

    if (!existing) {
      throw new NotFoundException(
        `Variant ${variantId} not found on merchandise ${merchandiseId}`,
      );
    }

    const data: UpdateVariantData = {};

    if (dto.size !== undefined) {
      data.size = emptyToNull(dto.size);
    }

    if (dto.color !== undefined) {
      data.color = emptyToNull(dto.color);
    }

    if (dto.sku !== undefined) {
      data.sku = dto.sku.trim().toUpperCase();
    }

    if (dto.stock !== undefined) {
      assertStock(dto.stock);
      data.stock = dto.stock;
    }

    const result = await this.repository.updateVariant(variantId, data);

    if (result.outcome === 'DUPLICATE_SKU') {
      throw new ConflictException(
        `SKU ${result.sku} is already in use by another variant.`,
      );
    }

    return toVariantItem(result.variant);
  }

  /**
   * Hard delete — a variant has no `deletedAt`.
   *
   * Returns the removed row so the audit entry can name the SKU, which is the
   * only way to tell afterwards which of five near-identical rows went.
   */
  async removeVariant(
    merchandiseId: string,
    variantId: string,
  ): Promise<MerchandiseVariantItem> {
    await this.getOrThrow(merchandiseId);

    const existing = await this.repository.findVariant(
      merchandiseId,
      variantId,
    );

    if (!existing) {
      throw new NotFoundException(
        `Variant ${variantId} not found on merchandise ${merchandiseId}`,
      );
    }

    await this.repository.deleteVariant(variantId);

    return toVariantItem(existing);
  }

  /**
   * Turns submitted variants into rows, filling in the SKUs.
   *
   * `taken` accumulates as it goes, so a batch of three identical variants gets
   * three distinct SKUs instead of one repeated three times and a unique
   * violation on the second insert.
   *
   * A SKU the admin typed is used verbatim (upper-cased) and clashes are a 409 —
   * silently renaming someone's SKU to `…-2` would be worse than refusing it,
   * because the SKU is how their warehouse finds the item.
   */
  private resolveVariants(
    merchandiseId: string,
    dtos: CreateVariantDto[],
    existingSkus: string[],
  ): VariantInput[] {
    const taken = new Set(existingSkus);
    const rows: VariantInput[] = [];

    for (const dto of dtos) {
      assertStock(dto.stock);

      const size = emptyToNull(dto.size);
      const color = emptyToNull(dto.color);

      let sku: string;

      if (dto.sku) {
        sku = dto.sku.trim().toUpperCase();

        if (taken.has(sku)) {
          throw new ConflictException(
            `SKU ${sku} is already in use by another variant.`,
          );
        }
      } else {
        sku = disambiguateSku(generateSku(merchandiseId, size, color), taken);
      }

      taken.add(sku);

      // Stock is NEVER decremented anywhere in this module: Milestone 1 has no
      // ordering flow, so the only thing that changes a number is an admin
      // editing it (docs/phases/PHASE-5.md, "Stock").
      rows.push({ size, color, sku, stock: dto.stock ?? 0 });
    }

    return rows;
  }

  private buildListArgs(query: QueryMerchandiseDto): ListMerchandiseArgs {
    return {
      filter: {
        search: query.search?.trim() ? query.search.trim() : undefined,
        status: query.status,
        includeDeleted: query.includeDeleted === true,
      },
      sortBy: resolveSortField(
        query.sortBy,
        SORTABLE_FIELDS,
        DEFAULT_SORT_FIELD,
      ),
      sortOrder: query.sortOrder === SortOrder.ASC ? 'asc' : 'desc',
      skip: query.skip,
      take: query.take,
    };
  }

  private async getOrThrow(id: string): Promise<MerchandiseWithRelations> {
    const merchandise = await this.repository.findById(id);

    if (!merchandise) {
      throw new NotFoundException(`Merchandise ${id} not found`);
    }

    return merchandise;
  }
}

/**
 * Checked here as well as in the DTO: the pipe protects the HTTP edge, this
 * protects the method. A service that is only correct when called through a
 * controller is a service with a hole in it.
 *
 * A third decimal is refused rather than rounded. `NUMERIC(18,2)` would accept
 * `19.999` and silently store `20.00`, so the client would never learn its
 * price had changed.
 */
function assertPrice(price: string): Money {
  if (!isValidMoneyString(price.trim())) {
    throw new UnprocessableEntityException(
      'price must be a non-negative amount with at most 2 decimal places.',
    );
  }

  return toMoney(price.trim());
}

/** Stock counts things that exist, so negative is meaningless, not merely odd. */
function assertStock(stock: number | undefined): void {
  if (stock === undefined) {
    return;
  }

  if (!Number.isInteger(stock) || stock < 0) {
    throw new UnprocessableEntityException(
      'stock must be a non-negative whole number.',
    );
  }

  if (stock > MAX_VARIANT_STOCK) {
    throw new UnprocessableEntityException(
      `stock cannot exceed ${MAX_VARIANT_STOCK}.`,
    );
  }
}
