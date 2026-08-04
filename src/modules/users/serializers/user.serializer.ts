import type { User, UserSource, UserStatus, UserTier } from '@prisma/client';

import { formatMoney } from '../../../common/money/money.util';
import {
  initialsOf,
  joinFullName,
} from '../../../common/text/split-full-name.util';

/**
 * The row shape rendered by the users table and the dashboard.
 *
 * `fullName` and `initials` are computed here rather than in each consumer so
 * the table, the dashboard avatars and the CSV export can never disagree about
 * how "Mary Jane Watson" is displayed. See docs/03-API-CONTRACT.md.
 */
export interface UserListItem {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  initials: string;
  email: string;
  phone: string | null;
  status: UserStatus;
  tier: UserTier;
  source: UserSource;
  /** Two-decimal string, never a float. */
  balance: string;
  country: string | null;
  lastActiveAt: Date | null;
  createdAt: Date;
}

export interface UserDetail extends UserListItem {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  emailVerified: boolean;
  emailVerifiedAt: Date | null;
  createdByAdminId: string | null;
  webhookEventId: string | null;
  deletedAt: Date | null;
  updatedAt: Date;
}

export interface UserBalance {
  userId: string;
  balance: string;
}

export interface BalanceAdjustment extends UserBalance {
  previousBalance: string;
  amount: string;
  reason: string;
}

export function toUserListItem(user: User): UserListItem {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    fullName: joinFullName(user.firstName, user.lastName),
    initials: initialsOf(user.firstName, user.lastName),
    email: user.email,
    phone: user.phone,
    status: user.status,
    tier: user.tier,
    source: user.source,
    balance: formatMoney(user.balance),
    country: user.country,
    lastActiveAt: user.lastActiveAt,
    createdAt: user.createdAt,
  };
}

export function toUserDetail(user: User): UserDetail {
  return {
    ...toUserListItem(user),
    addressLine1: user.addressLine1,
    addressLine2: user.addressLine2,
    city: user.city,
    state: user.state,
    postalCode: user.postalCode,
    emailVerified: user.emailVerified,
    emailVerifiedAt: user.emailVerifiedAt,
    createdByAdminId: user.createdByAdminId,
    webhookEventId: user.webhookEventId,
    deletedAt: user.deletedAt,
    updatedAt: user.updatedAt,
  };
}
