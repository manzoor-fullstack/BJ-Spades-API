import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ItemStatus, RewardCategory } from '@prisma/client';

import {
  buildPaginationMeta,
  resolveSortField,
  SortOrder,
} from '../../common/dto/pagination.dto';
import type { Paginated } from '../../common/interceptors/transform.interceptor';
import type { AuthenticatedAdmin } from '../auth/interfaces/authenticated-admin.interface';
import type { ValidatableUpload } from '../storage/image-validation';
import { MediaService } from '../storage/media.service';

import { CreateRewardDto, MAX_REWARD_STOCK } from './dto/create-reward.dto';
import { QueryRewardsDto } from './dto/query-rewards.dto';
import { UpdateRewardDto } from './dto/update-reward.dto';
import { RewardsRepository } from './repositories/rewards.repository';
import type {
  CreateRewardData,
  ListRewardsArgs,
  RewardWithRelations,
  UpdateRewardData,
} from './repositories/rewards.repository';
import {
  toRewardDetail,
  toRewardListItem,
} from './serializers/reward.serializer';
import type {
  RewardDetail,
  RewardListItem,
} from './serializers/reward.serializer';

/**
 * Columns a client may sort by. `sortBy` reaches Prisma as an object key, so an
 * unfiltered value both widens the injection surface and exposes columns that
 * were never meant to be orderable.
 */
const SORTABLE_FIELDS = [
  'createdAt',
  'updatedAt',
  'name',
  'company',
  'category',
  'status',
  'stock',
  'redeemedCount',
] as const;

const DEFAULT_SORT_FIELD = 'createdAt';

/** Storage folder for reward icons; also the URL path segment. */
export const REWARD_IMAGE_FOLDER = 'rewards';

function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

@Injectable()
export class RewardsService {
  constructor(
    private readonly repository: RewardsRepository,
    private readonly media: MediaService,
  ) {}

  async findAll(query: QueryRewardsDto): Promise<Paginated<RewardListItem[]>> {
    const args = this.buildListArgs(query);

    const [rewards, total] = await Promise.all([
      this.repository.findMany(args),
      this.repository.count(args.filter),
    ]);

    return {
      data: rewards.map(toRewardListItem),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async findOne(id: string): Promise<RewardDetail> {
    return toRewardDetail(await this.getOrThrow(id));
  }

  async create(
    dto: CreateRewardDto,
    image: ValidatableUpload | undefined,
    admin: AuthenticatedAdmin,
  ): Promise<RewardDetail> {
    // Checked here as well as in the DTO: the pipe protects the HTTP edge, this
    // protects the method. A service that is only correct when called through a
    // controller is a service with a hole in it.
    assertStock(dto.stock);

    const asset = image
      ? await this.media.uploadImage(image, REWARD_IMAGE_FOLDER, admin.id)
      : null;

    const data: CreateRewardData = {
      name: dto.rewardName.trim(),
      company: dto.company.trim(),
      category: dto.category ?? RewardCategory.GENERAL,
      value: dto.value.trim(),
      description: emptyToNull(dto.description),
      terms: emptyToNull(dto.termsConditions),
      imageId: asset?.id ?? null,
      status: dto.status ?? ItemStatus.ACTIVE,
      // Undefined means the field was never sent, which is "unlimited".
      stock: dto.stock ?? null,
      createdByAdminId: admin.id,
    };

    try {
      return toRewardDetail(await this.repository.create(data));
    } catch (error) {
      // The asset was written before the row that references it, so a failed
      // insert would leave a file nothing points at. The orphan sweep would
      // eventually collect it; removing it now is cheaper and immediate.
      await this.media.deleteAsset(asset?.id);
      throw error;
    }
  }

  async update(
    id: string,
    dto: UpdateRewardDto,
    image: ValidatableUpload | undefined,
    admin: AuthenticatedAdmin,
  ): Promise<RewardDetail> {
    const existing = await this.getOrThrow(id);

    assertStock(dto.stock);

    const data: UpdateRewardData = {};

    if (dto.rewardName !== undefined) {
      data.name = dto.rewardName.trim();
    }

    if (dto.company !== undefined) {
      data.company = dto.company.trim();
    }

    if (dto.category !== undefined) {
      data.category = dto.category;
    }

    if (dto.value !== undefined) {
      data.value = dto.value.trim();
    }

    if (dto.description !== undefined) {
      data.description = emptyToNull(dto.description);
    }

    if (dto.termsConditions !== undefined) {
      data.terms = emptyToNull(dto.termsConditions);
    }

    if (dto.status !== undefined) {
      data.status = dto.status;
    }

    if (dto.stock !== undefined) {
      data.stock = dto.stock;
    }

    // Uploaded before the update so a rejected image never half-applies the
    // rest of the form.
    const asset = image
      ? await this.media.uploadImage(image, REWARD_IMAGE_FOLDER, admin.id)
      : null;

    if (asset) {
      data.imageId = asset.id;
    }

    let updated: RewardWithRelations;

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

    return toRewardDetail(updated);
  }

  /**
   * Soft delete. Returns the deleted reward even though the route answers 204 —
   * Nest discards the body but the value still reaches AuditInterceptor, which
   * is what lets the audit entry name the reward instead of a bare UUID.
   *
   * The image is deliberately NOT deleted: the row still references it, and
   * MediaRepository.findOrphans counts a soft-deleted reward as a reference.
   */
  async remove(id: string): Promise<RewardDetail> {
    await this.getOrThrow(id);

    return toRewardDetail(await this.repository.softDelete(id, new Date()));
  }

  private buildListArgs(query: QueryRewardsDto): ListRewardsArgs {
    return {
      filter: {
        search: query.search?.trim() ? query.search.trim() : undefined,
        status: query.status,
        category: query.category,
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

  private async getOrThrow(id: string): Promise<RewardWithRelations> {
    const reward = await this.repository.findById(id);

    if (!reward) {
      throw new NotFoundException(`Reward ${id} not found`);
    }

    return reward;
  }
}

/**
 * Stock is a count of things that exist, so negative is meaningless rather than
 * merely unusual. Zero is legal and means out of stock — the admin still sees
 * the reward.
 */
function assertStock(stock: number | undefined): void {
  if (stock === undefined) {
    return;
  }

  if (!Number.isInteger(stock) || stock < 0) {
    throw new UnprocessableEntityException(
      'stock must be a non-negative whole number; omit it for unlimited.',
    );
  }

  if (stock > MAX_REWARD_STOCK) {
    throw new UnprocessableEntityException(
      `stock cannot exceed ${MAX_REWARD_STOCK}.`,
    );
  }
}
