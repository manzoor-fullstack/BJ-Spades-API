import type { Reward, RewardRedemption } from '@prisma/client';

import { formatMoney } from '../../common/money/money.util';
import type { PlayerRedemptionRow } from './repositories/player-rewards.repository';

type CatalogReward = Reward & {
  image: { url: string } | null;
};

export function toPlayerReward(reward: CatalogReward) {
  return {
    id: reward.id,
    name: reward.name,
    company: reward.company,
    category: reward.category,
    description: reward.description,
    terms: reward.terms,
    imageUrl: reward.image?.url ?? null,
    denomination: formatMoney(reward.denomination ?? 0),
    tokenCost: formatMoney(reward.tokenCost ?? 0),
    bonusPercent: reward.bonusPercent,
    stock: reward.stock,
    isBoosted: reward.bonusPercent > 0,
    availableUntil: reward.availableUntil,
  };
}

export function toPlayerRedemption(
  row: PlayerRedemptionRow,
  code: string | null = null,
) {
  return {
    id: row.id,
    status: row.status,
    denomination: formatMoney(row.denomination),
    tokenCost: formatMoney(row.tokenCost),
    code,
    reward: {
      id: row.reward.id,
      name: row.reward.name,
      company: row.reward.company,
      terms: row.reward.terms,
      imageUrl: row.reward.image?.url ?? null,
    },
    expiresAt: row.expiresAt,
    fulfilledAt: row.fulfilledAt,
    redeemedAt: row.redeemedAt,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type PlayerRedemption = ReturnType<typeof toPlayerRedemption>;
export type PlayerReward = ReturnType<typeof toPlayerReward>;

export function hasDeliverableCode(
  row: Pick<RewardRedemption, 'status'> & PlayerRedemptionRow,
): boolean {
  return (
    (row.status === 'FULFILLED' || row.status === 'REDEEMED') &&
    Boolean(row.delivery?.encryptedCode)
  );
}
