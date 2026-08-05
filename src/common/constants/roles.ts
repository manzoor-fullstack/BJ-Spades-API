/**
 * The role that must never be locked out.
 *
 * Named here rather than compared against a literal at each call site: the
 * guard rails in AdminsService all key off this one name, and a typo in any of
 * them would silently disable the protection.
 */
export const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

export const ROLES = [
  {
    name: 'SUPER_ADMIN',
    displayName: 'Super Administrator',
    description: 'Has full access to the entire system.',
    isSystem: true,
  },
  {
    name: 'ADMIN',
    displayName: 'Administrator',
    description: 'Can manage most resources except system-level settings.',
    isSystem: true,
  },
  {
    name: 'MODERATOR',
    displayName: 'Moderator',
    description: 'Can manage users and tournaments.',
    isSystem: true,
  },
  {
    name: 'SUPPORT',
    displayName: 'Support',
    description: 'Can assist users and view activity logs.',
    isSystem: true,
  },
] as const;
