import { isEmail } from 'class-validator';

/**
 * The three cards on the settings page (docs/03-API-CONTRACT.md,
 * "Settings & Security"). `GET /settings` returns keys grouped by these.
 */
export const SETTING_GROUPS = ['general', 'notifications', 'security'] as const;

export type SettingGroup = (typeof SETTING_GROUPS)[number];

export type SettingValue = string | number | boolean;

export type SettingType = 'string' | 'email' | 'timezone' | 'boolean' | 'int';

export interface SettingDefinition {
  readonly group: SettingGroup;
  readonly type: SettingType;
  readonly default: SettingValue;
  /** Stored on the row, so the table explains itself without this file. */
  readonly description: string;
  /** Written to `Settings.isProtected`. */
  readonly isProtected?: boolean;
  readonly maxLength?: number;
  readonly min?: number;
  readonly max?: number;
}

/**
 * Every setting the API accepts, and nothing else.
 *
 * Key-value storage with no schema is a liability — a typo creates a setting
 * that nothing reads and no one notices. `PUT /settings` rejects a key that is
 * not in here with 400, and validates each value against its declared type and
 * bounds (docs/phases/PHASE-7.md, 7.2 / 7.5).
 *
 * Every key below is consumed by real behaviour:
 *
 * | Key                            | Consumed by                              |
 * |--------------------------------|------------------------------------------|
 * | security.sessionTimeoutMinutes | `Session.expiresAt` at login             |
 * | activity.retentionDays         | `ActivityLogService.pruneOlderThan`      |
 * | company.*                      | Returned for display                     |
 *
 * The four `notifications.*` toggles are the documented exception: they are
 * stored preferences with no consumer, because Milestone 1 has no email
 * service. They are honest persisted preferences, not a claim that mail is
 * being sent (docs/phases/PHASE-7.md, "Settings that actually do something").
 *
 * **There is deliberately no `twoFactorAuth` and no `ipWhitelisting` key**
 * (D-08, D-09). A toggle reading "Two-Factor Authentication: on" while no
 * second factor is ever requested tells the operator they are protected when
 * they are not, and they will act on that belief. The `Settings` table can
 * physically hold any key; the registry is what stops these two existing.
 */
export const SETTINGS_REGISTRY = {
  'company.name': {
    group: 'general',
    type: 'string',
    default: 'BJ Spades',
    description: 'Company name shown in the admin interface',
    maxLength: 100,
  },
  'company.adminEmail': {
    group: 'general',
    type: 'email',
    default: 'admin@bjspades.com',
    description: 'Primary administrative contact address',
  },
  'company.timezone': {
    group: 'general',
    type: 'timezone',
    default: 'America/New_York',
    description: 'IANA timezone used when displaying dates',
  },
  'notifications.newUsers': {
    group: 'notifications',
    type: 'boolean',
    default: true,
    description:
      'Stored preference: notify on new user registration. Not acted on — Milestone 1 has no email service.',
  },
  'notifications.securityAlerts': {
    group: 'notifications',
    type: 'boolean',
    default: true,
    description:
      'Stored preference: notify on security alerts. Not acted on — Milestone 1 has no email service.',
  },
  'notifications.largeTransactions': {
    group: 'notifications',
    type: 'boolean',
    default: true,
    description:
      'Stored preference: notify on large transactions. Not acted on — Milestone 1 has no email service.',
  },
  'notifications.dailySummary': {
    group: 'notifications',
    type: 'boolean',
    default: false,
    description:
      'Stored preference: send a daily summary. Not acted on — Milestone 1 has no email service.',
  },

  'security.sessionTimeoutMinutes': {
    group: 'security',
    type: 'int',
    default: 10080,
    description:
      'How long a session stays valid after sign-in, in minutes. Applied to Session.expiresAt at the next login.',
    isProtected: true,
    min: 15,
    max: 43200,
  },
  'payouts.frozen': {
    group: 'security',
    type: 'boolean',
    default: false,
    description:
      'Emergency stop. While true, POST /payouts/:id/process refuses with 422 and no transfer reaches Stripe. Enforced, not advisory.',
    isProtected: true,
  },
  'activity.retentionDays': {
    group: 'security',
    type: 'int',
    default: 180,
    description:
      'How long activity log entries are kept before the pruning task removes them.',
    isProtected: true,
    min: 30,
    max: 730,
  },
} as const satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof SETTINGS_REGISTRY;

/**
 * The subset of keys declared `int`, derived rather than listed so a new
 * numeric setting cannot be forgotten here.
 */
export type IntSettingKey = {
  [K in SettingKey]: (typeof SETTINGS_REGISTRY)[K]['type'] extends 'int'
    ? K
    : never;
}[SettingKey];

export const SETTING_KEYS = Object.keys(SETTINGS_REGISTRY) as SettingKey[];

/** A complete, resolved set of values — one entry per registry key. */
export type SettingsSnapshot = Record<SettingKey, SettingValue>;

/** The `GET /settings` payload: keys nested under their group. */
export type GroupedSettings = Record<
  SettingGroup,
  Record<string, SettingValue>
>;

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS_REGISTRY, key);
}

export function settingDefinition(key: SettingKey): SettingDefinition {
  return SETTINGS_REGISTRY[key];
}

/** The compiled-in values, used for any key with no row in the table yet. */
export function defaultSettings(): SettingsSnapshot {
  const snapshot = {} as SettingsSnapshot;

  for (const key of SETTING_KEYS) {
    snapshot[key] = SETTINGS_REGISTRY[key].default;
  }

  return snapshot;
}

export function groupSettings(snapshot: SettingsSnapshot): GroupedSettings {
  const grouped = {} as GroupedSettings;

  for (const group of SETTING_GROUPS) {
    grouped[group] = {};
  }

  for (const key of SETTING_KEYS) {
    grouped[SETTINGS_REGISTRY[key].group][key] = snapshot[key];
  }

  return grouped;
}

export type SettingValidation =
  { valid: true; value: SettingValue } | { valid: false; message: string };

/**
 * IANA timezone check.
 *
 * `Intl.DateTimeFormat` throws a RangeError for an identifier the runtime does
 * not know, which is the only complete list available without shipping one.
 */
function isValidTimeZone(value: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value });

    return true;
  } catch {
    return false;
  }
}

function validateInt(
  definition: SettingDefinition,
  value: unknown,
): SettingValidation {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { valid: false, message: 'must be a whole number' };
  }

  if (definition.min !== undefined && value < definition.min) {
    return { valid: false, message: `must be at least ${definition.min}` };
  }

  if (definition.max !== undefined && value > definition.max) {
    return { valid: false, message: `must be at most ${definition.max}` };
  }

  return { valid: true, value };
}

type StringValidation =
  { valid: true; value: string } | { valid: false; message: string };

function validateString(
  definition: SettingDefinition,
  value: unknown,
): StringValidation {
  if (typeof value !== 'string') {
    return { valid: false, message: 'must be a string' };
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    return { valid: false, message: 'must not be empty' };
  }

  if (
    definition.maxLength !== undefined &&
    trimmed.length > definition.maxLength
  ) {
    return {
      valid: false,
      message: `must be at most ${definition.maxLength} characters`,
    };
  }

  return { valid: true, value: trimmed };
}

/**
 * Checks one value against its registry entry.
 *
 * Returns a result rather than throwing so the caller can collect every
 * failing key into a single 400 — a settings form that reports its problems
 * one save at a time is a form nobody finishes.
 */
export function validateSettingValue(
  key: SettingKey,
  value: unknown,
): SettingValidation {
  const definition = SETTINGS_REGISTRY[key];

  switch (definition.type) {
    case 'boolean':
      return typeof value === 'boolean'
        ? { valid: true, value }
        : { valid: false, message: 'must be true or false' };

    case 'int':
      return validateInt(definition, value);

    case 'email': {
      const result = validateString(definition, value);

      if (!result.valid) return result;

      return isEmail(result.value)
        ? result
        : { valid: false, message: 'must be a valid email address' };
    }

    case 'timezone': {
      const result = validateString(definition, value);

      if (!result.valid) return result;

      return isValidTimeZone(result.value)
        ? result
        : { valid: false, message: 'must be a valid IANA timezone' };
    }

    case 'string':
      return validateString(definition, value);
  }
}
