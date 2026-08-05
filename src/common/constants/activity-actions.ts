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
