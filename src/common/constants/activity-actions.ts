import { ActivityCategory } from '@prisma/client';

/**
 * One entry in the action catalogue.
 *
 * `title` is the default sentence written when a caller does not compose a more
 * specific one. Titles are stored on the row rather than rendered on read, so
 * an entry keeps saying what was true when it was written (docs/phases/PHASE-2.md).
 */
export interface ActivityActionDefinition {
  readonly category: ActivityCategory;
  readonly code: string;
  readonly title: string;
  readonly isHighPriority: boolean;
}

/**
 * The authoritative catalogue of audit action codes.
 *
 * Codes are stored in `ActivityLog.action` and filtered on by the frontend, so
 * they are a contract: add entries, never rename them. Each later phase extends
 * this object rather than inventing strings at the call site — that is the only
 * thing stopping `user.suspended` and `user.suspend` from both existing.
 */
export const ACTIVITY_ACTIONS = {
  AUTH_LOGIN: {
    category: ActivityCategory.AUTH,
    code: 'auth.login',
    title: 'Admin signed in',
    isHighPriority: false,
  },
  AUTH_LOGIN_FAILED: {
    category: ActivityCategory.AUTH,
    code: 'auth.login_failed',
    title: 'Failed sign-in attempt',
    isHighPriority: true,
  },
  AUTH_LOGOUT: {
    category: ActivityCategory.AUTH,
    code: 'auth.logout',
    title: 'Admin signed out',
    isHighPriority: false,
  },
  AUTH_LOGOUT_ALL: {
    category: ActivityCategory.AUTH,
    code: 'auth.logout_all',
    title: 'Admin signed out of all other sessions',
    isHighPriority: false,
  },
  AUTH_SESSION_REVOKED: {
    category: ActivityCategory.AUTH,
    code: 'auth.session_revoked',
    title: 'Session revoked',
    isHighPriority: true,
  },
  AUTH_TOKEN_REUSE_DETECTED: {
    category: ActivityCategory.AUTH,
    code: 'auth.token_reuse_detected',
    title: 'Refresh token reuse detected',
    isHighPriority: true,
  },

  USER_CREATED: {
    category: ActivityCategory.USER,
    code: 'user.created',
    title: 'User created',
    isHighPriority: false,
  },
  USER_UPDATED: {
    category: ActivityCategory.USER,
    code: 'user.updated',
    title: 'User updated',
    isHighPriority: false,
  },
  USER_SUSPENDED: {
    category: ActivityCategory.USER,
    code: 'user.suspended',
    title: 'User suspended',
    isHighPriority: true,
  },
  USER_ACTIVATED: {
    category: ActivityCategory.USER,
    code: 'user.activated',
    title: 'User activated',
    isHighPriority: false,
  },
  USER_DELETED: {
    category: ActivityCategory.USER,
    code: 'user.deleted',
    title: 'User deleted',
    isHighPriority: true,
  },
  USER_BALANCE_ADJUSTED: {
    category: ActivityCategory.USER,
    code: 'user.balance_adjusted',
    title: 'User balance adjusted',
    isHighPriority: true,
  },

  ADMIN_CREATED: {
    category: ActivityCategory.ADMIN,
    code: 'admin.created',
    title: 'Administrator created',
    // Every admin.* entry that hands out, moves, or removes access is high
    // priority: these are the rows read first after a suspected compromise.
    isHighPriority: true,
  },
  ADMIN_UPDATED: {
    category: ActivityCategory.ADMIN,
    code: 'admin.updated',
    title: 'Administrator updated',
    isHighPriority: false,
  },
  ADMIN_DELETED: {
    category: ActivityCategory.ADMIN,
    code: 'admin.deleted',
    title: 'Administrator deleted',
    isHighPriority: true,
  },
  ADMIN_ACTIVATED: {
    category: ActivityCategory.ADMIN,
    code: 'admin.activated',
    title: 'Administrator activated',
    isHighPriority: true,
  },
  ADMIN_DEACTIVATED: {
    category: ActivityCategory.ADMIN,
    code: 'admin.deactivated',
    title: 'Administrator deactivated',
    isHighPriority: true,
  },
  ADMIN_ROLE_CHANGED: {
    category: ActivityCategory.ADMIN,
    code: 'admin.role_changed',
    title: 'Administrator role changed',
    isHighPriority: true,
  },

  ROLE_CREATED: {
    category: ActivityCategory.ADMIN,
    code: 'role.created',
    title: 'Role created',
    isHighPriority: false,
  },
  ROLE_UPDATED: {
    category: ActivityCategory.ADMIN,
    code: 'role.updated',
    title: 'Role updated',
    isHighPriority: false,
  },
  ROLE_DELETED: {
    category: ActivityCategory.ADMIN,
    code: 'role.deleted',
    title: 'Role deleted',
    isHighPriority: true,
  },
  ROLE_PERMISSIONS_CHANGED: {
    category: ActivityCategory.ADMIN,
    code: 'role.permissions_changed',
    title: 'Role permissions changed',
    isHighPriority: true,
  },

  TOURNAMENT_CREATED: {
    category: ActivityCategory.TOURNAMENT,
    code: 'tournament.created',
    title: 'Tournament created',
    isHighPriority: false,
  },
  TOURNAMENT_UPDATED: {
    category: ActivityCategory.TOURNAMENT,
    code: 'tournament.updated',
    title: 'Tournament updated',
    isHighPriority: false,
  },
  TOURNAMENT_CANCELLED: {
    category: ActivityCategory.TOURNAMENT,
    code: 'tournament.cancelled',
    title: 'Tournament cancelled',
    // High priority: a cancellation refunds entry fees from Phase 6 onwards and
    // is the first thing looked up when players ask what happened.
    isHighPriority: true,
  },
  TOURNAMENT_DELETED: {
    category: ActivityCategory.TOURNAMENT,
    code: 'tournament.deleted',
    title: 'Tournament deleted',
    // Deletion cascades to every registration, so this is destructive in a way
    // cancellation is not.
    isHighPriority: true,
  },
  TOURNAMENT_PLAYER_REGISTERED: {
    category: ActivityCategory.TOURNAMENT,
    code: 'tournament.player_registered',
    title: 'Player registered for tournament',
    isHighPriority: false,
  },
  TOURNAMENT_PLAYER_REMOVED: {
    category: ActivityCategory.TOURNAMENT,
    code: 'tournament.player_removed',
    title: 'Player removed from tournament',
    isHighPriority: false,
  },
  TOURNAMENT_RESULTS_SUBMITTED: {
    category: ActivityCategory.TOURNAMENT,
    code: 'tournament.results_submitted',
    title: 'Tournament results submitted',
    isHighPriority: false,
  },

  REWARD_CREATED: {
    category: ActivityCategory.REWARD,
    code: 'reward.created',
    title: 'Reward created',
    isHighPriority: false,
  },
  REWARD_UPDATED: {
    category: ActivityCategory.REWARD,
    code: 'reward.updated',
    title: 'Reward updated',
    isHighPriority: false,
  },
  REWARD_DELETED: {
    category: ActivityCategory.REWARD,
    code: 'reward.deleted',
    title: 'Reward deleted',
    // High priority for the same reason every other delete is: it removes an
    // offer players may already have seen, and it is the entry an operator
    // looks for when asked where a reward went.
    isHighPriority: true,
  },

  MERCHANDISE_CREATED: {
    category: ActivityCategory.MERCHANDISE,
    code: 'merchandise.created',
    title: 'Merchandise created',
    isHighPriority: false,
  },
  MERCHANDISE_UPDATED: {
    category: ActivityCategory.MERCHANDISE,
    code: 'merchandise.updated',
    title: 'Merchandise updated',
    isHighPriority: false,
  },
  MERCHANDISE_DELETED: {
    category: ActivityCategory.MERCHANDISE,
    code: 'merchandise.deleted',
    title: 'Merchandise deleted',
    isHighPriority: true,
  },
  MERCHANDISE_VARIANT_ADDED: {
    category: ActivityCategory.MERCHANDISE,
    code: 'merchandise.variant_added',
    title: 'Merchandise variant added',
    isHighPriority: false,
  },
  MERCHANDISE_VARIANT_UPDATED: {
    category: ActivityCategory.MERCHANDISE,
    code: 'merchandise.variant_updated',
    title: 'Merchandise variant updated',
    isHighPriority: false,
  },
  MERCHANDISE_VARIANT_REMOVED: {
    category: ActivityCategory.MERCHANDISE,
    code: 'merchandise.variant_removed',
    title: 'Merchandise variant removed',
    // A variant has no `deletedAt` — removing one is a hard delete that takes
    // its SKU and stock count with it, unlike the soft-deleted product above.
    isHighPriority: true,
  },

  // Every payout action is high priority without exception: these are the only
  // rows in the system that correspond to money leaving the platform, and an
  // incorrect transfer is unrecoverable. There is no "routine" payout event.
  PAYOUT_APPROVED: {
    category: ActivityCategory.PAYOUT,
    code: 'payout.approved',
    title: 'Payout approved',
    isHighPriority: true,
  },
  PAYOUT_PROCESSED: {
    category: ActivityCategory.PAYOUT,
    code: 'payout.processed',
    title: 'Payout processed',
    isHighPriority: true,
  },
  PAYOUT_CANCELLED: {
    category: ActivityCategory.PAYOUT,
    code: 'payout.cancelled',
    title: 'Payout cancelled',
    isHighPriority: true,
  },

  // Claims and disputes decide whether money is owed at all, so they carry the
  // same weight as the payout actions above.
  CLAIM_APPROVED: {
    category: ActivityCategory.PAYOUT,
    code: 'claim.approved',
    title: 'Prize claim approved',
    isHighPriority: true,
  },
  CLAIM_DECLINED: {
    category: ActivityCategory.PAYOUT,
    code: 'claim.declined',
    title: 'Prize claim declined',
    isHighPriority: true,
  },
  DISPUTE_CLEARED: {
    category: ActivityCategory.PAYOUT,
    code: 'dispute.cleared',
    title: 'Dispute cleared',
    isHighPriority: true,
  },
  DISPUTE_DISQUALIFIED: {
    category: ActivityCategory.PAYOUT,
    code: 'dispute.disqualified',
    title: 'Player disqualified',
    isHighPriority: true,
  },
  PAYOUT_FAILED: {
    category: ActivityCategory.PAYOUT,
    code: 'payout.failed',
    title: 'Payout failed',
    isHighPriority: true,
  },
  PAYOUT_STRIPE_ONBOARDING_STARTED: {
    category: ActivityCategory.PAYOUT,
    code: 'payout.stripe_onboarding_started',
    title: 'Stripe onboarding link generated',
    isHighPriority: true,
  },
  PAYOUT_STRIPE_ACCOUNT_UPDATED: {
    category: ActivityCategory.PAYOUT,
    code: 'payout.stripe_account_updated',
    title: 'Stripe account status updated',
    isHighPriority: true,
  },

  /**
   * A ledger write made through TransactionsService rather than through
   * `POST /users/:id/balance/adjust`.
   *
   * Filed under PAYOUT because `ActivityCategory` has no TRANSACTION member and
   * PAYOUT is the money category — an operator hunting a balance movement looks
   * there. Distinct from `user.balance_adjusted`, which is the *endpoint*: this
   * one records the ledger row itself.
   */
  TRANSACTION_BALANCE_ADJUSTED: {
    category: ActivityCategory.PAYOUT,
    code: 'transaction.balance_adjusted',
    title: 'Ledger balance adjusted',
    isHighPriority: true,
  },

  SETTINGS_UPDATED: {
    category: ActivityCategory.SETTINGS,
    code: 'settings.updated',
    title: 'Settings updated',
    // High priority: these values change how the platform behaves — how long a
    // session lives, how long the audit trail itself is kept. A change here is
    // one of the first things worth seeing after something unexpected.
    isHighPriority: true,
  },

  SECURITY_SESSION_REVOKED: {
    category: ActivityCategory.SECURITY,
    code: 'security.session_revoked',
    title: 'Session revoked by an administrator',
    isHighPriority: true,
  },

  WEBHOOK_USER_CREATED: {
    category: ActivityCategory.WEBHOOK,
    code: 'webhook.user_created',
    title: 'User registered via webhook',
    isHighPriority: false,
  },
  WEBHOOK_FAILED: {
    category: ActivityCategory.WEBHOOK,
    code: 'webhook.failed',
    title: 'Webhook processing failed',
    isHighPriority: true,
  },
} as const satisfies Record<string, ActivityActionDefinition>;

export type ActivityActionKey = keyof typeof ACTIVITY_ACTIONS;

/** Union of every catalogued code, so a typo is a compile error. */
export type ActivityActionCode =
  (typeof ACTIVITY_ACTIONS)[ActivityActionKey]['code'];

const BY_CODE: ReadonlyMap<string, ActivityActionDefinition> = new Map(
  Object.values(ACTIVITY_ACTIONS).map(
    (definition): [string, ActivityActionDefinition] => [
      definition.code,
      definition,
    ],
  ),
);

export function findActivityAction(
  code: string,
): ActivityActionDefinition | undefined {
  return BY_CODE.get(code);
}

/** The catalogue's default title for a code, used when none is composed. */
export function activityActionTitle(code: string): string {
  return BY_CODE.get(code)?.title ?? code;
}

export function isHighPriorityAction(code: string): boolean {
  return BY_CODE.get(code)?.isHighPriority ?? false;
}

export function activityActionCategory(
  code: string,
): ActivityCategory | undefined {
  return BY_CODE.get(code)?.category;
}
