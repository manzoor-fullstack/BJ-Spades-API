import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ActivityCategory } from '@prisma/client';

import { computeDiff } from '../../common/audit/compute-diff.util';
import { ACTIVITY_ACTIONS } from '../../common/constants/activity-actions';
import { setLowStockThreshold } from '../../common/constants/stock';
import type { RequestContext } from '../../common/http/request-context.util';
import {
  ActivityLogService,
  setActivityRetentionDays,
} from '../activity/activity.service';

import { UpdateSettingsDto } from './dto/update-settings.dto';
import {
  SettingsRepository,
  type SettingUpsert,
} from './repositories/settings.repository';
import {
  defaultSettings,
  groupSettings,
  isSettingKey,
  settingDefinition,
  SETTINGS_REGISTRY,
  validateSettingValue,
  type GroupedSettings,
  type IntSettingKey,
  type SettingKey,
  type SettingValue,
  type SettingsSnapshot,
} from './settings.registry';

interface FieldError {
  field: string;
  message: string;
}

/**
 * Reads and writes the typed settings registry.
 *
 * Two things make this more than a table wrapper:
 *
 *  - **A cache.** Settings are read on every login (session timeout) and on
 *    every merchandise or reward serialisation (low-stock threshold). A query
 *    per read would put a round trip on paths that have nothing to do with
 *    settings. The cache is dropped on write, not aged out, so a save is
 *    visible on the next request rather than up to some TTL later.
 *
 *  - **Applying what it read.** `security.sessionTimeoutMinutes`,
 *    `activity.retentionDays` and `inventory.lowStockThreshold` are consumed by
 *    code that must not depend on this module — a pure serializer helper and
 *    the audit-log service that every module already depends on. Rather than
 *    thread a service through both, the loaded values are pushed into the two
 *    runtime holders whenever the snapshot is (re)loaded. A settings page whose
 *    toggles change nothing is worse than no settings page
 *    (docs/phases/PHASE-7.md).
 */
@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);

  private cache: SettingsSnapshot | null = null;

  constructor(
    private readonly repository: SettingsRepository,
    private readonly activityLog: ActivityLogService,
  ) {}

  /**
   * Warms the cache at boot so the configured values are applied before the
   * first request, not after whoever happens to open the settings page first.
   *
   * A failure here is logged and swallowed: the application must still start
   * with the compiled-in defaults if the table cannot be read.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.getAll();
    } catch (error) {
      this.logger.error(
        `Could not load settings at startup; using defaults: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Every key resolved: stored value where there is one, default otherwise. */
  async getAll(): Promise<SettingsSnapshot> {
    if (this.cache) {
      return this.cache;
    }

    const snapshot = defaultSettings();
    const rows = await this.repository.findAll();

    for (const row of rows) {
      if (!isSettingKey(row.key)) {
        // A key that is no longer in the registry. Left in the table rather
        // than deleted — dropping rows on read would destroy data on a
        // rollback — but not served.
        continue;
      }

      const result = validateSettingValue(row.key, row.value);

      if (result.valid) {
        snapshot[row.key] = result.value;
      } else {
        this.logger.warn(
          `Stored value for "${row.key}" ${result.message}; using the default.`,
        );
      }
    }

    this.cache = snapshot;
    this.apply(snapshot);

    return snapshot;
  }

  async getGrouped(): Promise<GroupedSettings> {
    return groupSettings(await this.getAll());
  }

  /** Drops the cache. Called on write, and by the integration suite. */
  invalidate(): void {
    this.cache = null;
  }

  async getSessionTimeoutMinutes(): Promise<number> {
    return this.getNumber('security.sessionTimeoutMinutes');
  }

  /**
   * The configured retention window.
   *
   * `ActivityLogService.pruneOlderThan` reads the value pushed into its module
   * holder by `apply()` rather than calling this, because it must not depend on
   * SettingsModule. This is here for a maintenance script that wants the value
   * without going through the audit service.
   */
  async getActivityRetentionDays(): Promise<number> {
    return this.getNumber('activity.retentionDays');
  }

  /**
   * Whether the payout kill-switch is engaged.
   *
   * Read on every `process()` call rather than cached in a module holder: an
   * emergency stop that takes effect on the next restart is not an emergency
   * stop. The snapshot behind it is already cached, so this is not a query per
   * payout.
   */
  async isPayoutsFrozen(): Promise<boolean> {
    const snapshot = await this.getAll();

    return snapshot['payouts.frozen'] === true;
  }

  /**
   * Writes the supplied keys and nothing else.
   *
   * Every key is validated before anything is written, so a payload with one
   * bad value changes nothing — a partial save would leave the operator
   * guessing which half landed.
   */
  async update(
    patch: UpdateSettingsDto,
    adminId: string,
    context: RequestContext = {},
  ): Promise<GroupedSettings> {
    const submitted = Object.entries(patch as Record<string, unknown>).filter(
      ([, value]) => value !== undefined,
    );

    const errors: FieldError[] = [];
    const accepted = new Map<SettingKey, SettingValue>();

    for (const [key, value] of submitted) {
      if (!isSettingKey(key)) {
        errors.push({ field: key, message: 'is not a known setting' });
        continue;
      }

      const result = validateSettingValue(key, value);

      if (result.valid) {
        accepted.set(key, result.value);
      } else {
        errors.push({ field: key, message: result.message });
      }
    }

    if (errors.length > 0) {
      throw new BadRequestException({
        message: 'One or more settings are invalid',
        details: errors,
      });
    }

    const before = await this.getAll();

    // Only the keys whose value actually moved reach the table, so a save with
    // no edits does not stamp `updatedBy` across every row.
    const changed = [...accepted.entries()].filter(
      ([key, value]) => before[key] !== value,
    );

    if (changed.length > 0) {
      await this.repository.upsertMany(
        changed.map(([key, value]): SettingUpsert => {
          // Read through the accessor so the declared `SettingDefinition` type
          // applies: the registry is `as const`, so indexing it directly gives
          // a union in which the optional fields are absent, not optional.
          const definition = settingDefinition(key);

          return {
            key,
            value,
            category: definition.group,
            description: definition.description,
            isProtected: definition.isProtected ?? false,
          };
        }),
        adminId,
      );

      this.invalidate();
    }

    const after = await this.getAll();

    if (changed.length > 0) {
      await this.recordChange(before, after, changed, adminId, context);
    }

    return groupSettings(after);
  }

  // ─── Internals ───────────────────────────────────────────────

  private async getNumber(key: IntSettingKey): Promise<number> {
    const snapshot = await this.getAll();
    const value = snapshot[key];

    return typeof value === 'number' ? value : SETTINGS_REGISTRY[key].default;
  }

  /**
   * Pushes the loaded values into the consumers that cannot depend on this
   * module. See the class comment.
   */
  private apply(snapshot: SettingsSnapshot): void {
    const threshold = snapshot['inventory.lowStockThreshold'];
    const retention = snapshot['activity.retentionDays'];

    if (typeof threshold === 'number') {
      setLowStockThreshold(threshold);
    }

    if (typeof retention === 'number') {
      setActivityRetentionDays(retention);
    }
  }

  /**
   * Written here rather than through `@AuditLog`, for the same reason
   * `AuthService` logs its own failed sign-ins: the interceptor runs after the
   * handler and never sees the pre-update values, so it cannot produce a diff.
   * PHASE-7 G3 requires the entry to contain one.
   */
  private async recordChange(
    before: SettingsSnapshot,
    after: SettingsSnapshot,
    changed: [SettingKey, SettingValue][],
    adminId: string,
    context: RequestContext,
  ): Promise<void> {
    const keys = changed.map(([key]) => key);

    const changes = computeDiff(
      Object.fromEntries(keys.map((key) => [key, before[key]])),
      Object.fromEntries(keys.map((key) => [key, after[key]])),
    );

    await this.activityLog.record({
      category: ActivityCategory.SETTINGS,
      action: ACTIVITY_ACTIONS.SETTINGS_UPDATED.code,
      title: `Settings updated: ${keys.join(', ')}`,
      adminId,
      entityType: 'Settings',
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { keys, changes },
    });
  }
}
