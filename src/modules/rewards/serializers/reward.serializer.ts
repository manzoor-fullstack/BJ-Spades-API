import type { ItemStatus, RewardCategory } from '@prisma/client';

import { isLowStock } from '../../../common/constants/stock';
import type { RewardWithRelations } from '../repositories/rewards.repository';

export interface RewardImage {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
}

/**
 * The row rendered by the rewards grid.
 *
 * `value` is a display STRING and stays one — the field mixes "$20" with "100"
 * tokens, and making it arithmetic needs a unit enum the modal does not have
 * (docs/05-DEFERRED-SCOPE.md D-17). It is deliberately NOT run through
 * `formatMoney`.
 */
export interface RewardListItem {
  id: string;
  name: string;
  company: string;
  category: RewardCategory;
  value: string;
  description: string | null;
  terms: string | null;
  image: RewardImage | null;
  status: ItemStatus;
  /** null means unlimited — correct for a digital gift-card code. */
  stock: number | null;
  /** True only when stock is between 1 and the threshold; 0 is out of stock. */
  isLowStock: boolean;
  /** Reserved for Milestone 2 redemption; stays 0 for now. */
  redeemedCount: number;
  deletedAt: Date | null;
  createdAt: Date;
}

export interface RewardDetail extends RewardListItem {
  createdByAdminId: string;
  updatedAt: Date;
}

export function toRewardListItem(reward: RewardWithRelations): RewardListItem {
  return {
    id: reward.id,
    name: reward.name,
    company: reward.company,
    category: reward.category,
    value: reward.value,
    description: reward.description,
    terms: reward.terms,
    image: reward.image
      ? {
          id: reward.image.id,
          url: reward.image.url,
          width: reward.image.width,
          height: reward.image.height,
        }
      : null,
    status: reward.status,
    stock: reward.stock,
    isLowStock: isLowStock(reward.stock),
    redeemedCount: reward.redeemedCount,
    deletedAt: reward.deletedAt,
    createdAt: reward.createdAt,
  };
}

export function toRewardDetail(reward: RewardWithRelations): RewardDetail {
  return {
    ...toRewardListItem(reward),
    createdByAdminId: reward.createdByAdminId,
    updatedAt: reward.updatedAt,
  };
}
