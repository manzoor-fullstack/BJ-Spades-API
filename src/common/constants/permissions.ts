/**
 * The authoritative permission set (docs/02-DATA-MODEL.md, "Permission codes").
 *
 * Codes are the contract shared with the frontend and the seed data — the
 * string values are stored in the database and must never drift.
 */
export const PERMISSION_CODES = {
  DASHBOARD_VIEW: 'dashboard.view',
  USERS_MANAGE: 'users.manage',
  USERS_VIEW: 'users.view',
  TOURNAMENTS_MANAGE: 'tournaments.manage',
  REWARDS_MANAGE: 'rewards.manage',
  PAYOUTS_MANAGE: 'payouts.manage',
  PAYOUTS_VIEW: 'payouts.view',
  ADMINS_MANAGE: 'admins.manage',
  ROLES_MANAGE: 'roles.manage',
  ACTIVITY_VIEW: 'activity.view',
  SECURITY_MANAGE: 'security.manage',
  SETTINGS_MANAGE: 'settings.manage',
} as const;

export type PermissionCode =
  (typeof PERMISSION_CODES)[keyof typeof PERMISSION_CODES];
