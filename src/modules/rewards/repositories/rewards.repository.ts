import { Injectable } from '@nestjs/common';
import { ItemStatus, Prisma, RewardCategory } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

/** The reward card renders its icon, so the asset travels with every read. */
const REWARD_INCLUDE = {
  image: true,
} satisfies Prisma.RewardInclude;

export type RewardWithRelations = Prisma.RewardGetPayload<{
  include: typeof REWARD_INCLUDE;
}>;

/** Expressed in domain terms; translating to Prisma is this class's job. */
export interface RewardFilter {
  search?: string;
  status?: ItemStatus;
  category?: RewardCategory;
  /** Off by default — soft-deleted rewards are not part of the catalogue. */
  includeDeleted?: boolean;
}

export interface ListRewardsArgs {
  filter: RewardFilter;
  /** Already checked against an allowlist by the service. */
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  skip: number;
  take: number;
}

export interface CreateRewardData {
  name: string;
  company: string;
  category: RewardCategory;
  value: string;
  description: string | null;
  terms: string | null;
  imageId: string | null;
  status: ItemStatus;
  stock: number | null;
  createdByAdminId: string;
}

export interface UpdateRewardData {
  name?: string;
  company?: string;
  category?: RewardCategory;
  value?: string;
  description?: string | null;
  terms?: string | null;
  imageId?: string | null;
  status?: ItemStatus;
  stock?: number | null;
}

@Injectable()
export class RewardsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private buildWhere(filter: RewardFilter): Prisma.RewardWhereInput {
    const where: Prisma.RewardWhereInput = {};

    // The default. A caller wanting the deleted rows has to ask for them, which
    // is the only way "deleted" means anything to the rest of the app.
    if (!filter.includeDeleted) {
      where.deletedAt = null;
    }

    if (filter.status) {
      where.status = filter.status;
    }

    if (filter.category) {
      where.category = filter.category;
    }

    if (filter.search) {
      // Name and company, because the card shows both and an operator looking
      // for "Starbucks" is not thinking about which column that lives in.
      where.OR = [
        { name: { contains: filter.search, mode: 'insensitive' } },
        { company: { contains: filter.search, mode: 'insensitive' } },
      ];
    }

    return where;
  }

  findMany(args: ListRewardsArgs): Promise<RewardWithRelations[]> {
    return this.prisma.reward.findMany({
      where: this.buildWhere(args.filter),
      include: REWARD_INCLUDE,
      // The id tiebreak keeps paging stable when the sort column has ties;
      // without it page 2 can repeat a row from page 1.
      orderBy: [{ [args.sortBy]: args.sortOrder }, { id: 'asc' }],
      skip: args.skip,
      take: args.take,
    });
  }

  count(filter: RewardFilter): Promise<number> {
    return this.prisma.reward.count({ where: this.buildWhere(filter) });
  }

  /**
   * `includeDeleted` defaults to false so a soft-deleted reward 404s on a
   * direct fetch too — otherwise `DELETE` then `GET` would still return it.
   */
  findById(
    id: string,
    includeDeleted = false,
  ): Promise<RewardWithRelations | null> {
    return this.prisma.reward.findFirst({
      where: includeDeleted ? { id } : { id, deletedAt: null },
      include: REWARD_INCLUDE,
    });
  }

  create(data: CreateRewardData): Promise<RewardWithRelations> {
    return this.prisma.reward.create({ data, include: REWARD_INCLUDE });
  }

  update(id: string, data: UpdateRewardData): Promise<RewardWithRelations> {
    return this.prisma.reward.update({
      where: { id },
      data,
      include: REWARD_INCLUDE,
    });
  }

  /**
   * Soft delete. The row stays so a Milestone 2 redemption can still name the
   * reward it was for; `deletedAt` is what every default query filters on.
   */
  softDelete(id: string, deletedAt: Date): Promise<RewardWithRelations> {
    return this.prisma.reward.update({
      where: { id },
      data: { deletedAt },
      include: REWARD_INCLUDE,
    });
  }
}
