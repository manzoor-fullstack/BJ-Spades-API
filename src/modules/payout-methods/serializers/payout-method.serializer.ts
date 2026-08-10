import type { PayoutMethod, PayoutMethodAccount } from '@prisma/client';

import {
  initialsOf,
  joinFullName,
} from '../../../common/text/split-full-name.util';
import type { MethodAccountWithUser } from '../repositories/payout-methods.repository';

/**
 * The only rail this platform can settle over itself.
 *
 * Everything else is recorded so an operator knows where a player wants money
 * sent; paying it is a manual step outside the system.
 * `PayoutsService.process` enforces this with a 422.
 */
export const EXECUTABLE_METHODS: readonly PayoutMethod[] = ['STRIPE_CONNECT'];

export interface MethodOwner {
  id: string;
  fullName: string;
  initials: string;
  email: string;
}

export interface PayoutMethodAccountItem {
  id: string;
  user: MethodOwner;
  method: PayoutMethod;
  label: string | null;
  /** A handle or masked reference. Never a full credential. */
  reference: string;
  isVerified: boolean;
  isDefault: boolean;
  /**
   * Whether the platform can actually send money over this rail.
   *
   * Exposed so the UI never implies a connected Zelle account means Zelle
   * payouts will go out automatically — they will not.
   */
  isExecutable: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function toPayoutMethodAccountItem(
  account: MethodAccountWithUser,
): PayoutMethodAccountItem {
  return {
    id: account.id,
    user: {
      id: account.user.id,
      fullName: joinFullName(account.user.firstName, account.user.lastName),
      initials: initialsOf(account.user.firstName, account.user.lastName),
      email: account.user.email,
    },
    method: account.method,
    label: account.label,
    reference: account.reference,
    isVerified: account.isVerified,
    isDefault: account.isDefault,
    isExecutable: EXECUTABLE_METHODS.includes(account.method),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

export type { PayoutMethodAccount };
