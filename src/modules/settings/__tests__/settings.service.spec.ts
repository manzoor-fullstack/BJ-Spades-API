import { BadRequestException, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import {
  getLowStockThreshold,
  LOW_STOCK_THRESHOLD,
  setLowStockThreshold,
} from '../../../common/constants/stock';
import {
  ACTIVITY_RETENTION_DAYS,
  getActivityRetentionDays,
  setActivityRetentionDays,
  type ActivityLogService,
  type RecordActivityInput,
} from '../../activity/activity.service';
import { UpdateSettingsDto } from '../dto/update-settings.dto';
import type {
  SettingsRepository,
  SettingUpsert,
  StoredSetting,
} from '../repositories/settings.repository';
import {
  defaultSettings,
  SETTING_KEYS,
  SETTINGS_REGISTRY,
  validateSettingValue,
  type SettingKey,
} from '../settings.registry';
import { SettingsService } from '../settings.service';

type MockedRepository = { [K in keyof SettingsRepository]: jest.Mock };

/** The DTO is what the HTTP layer hands the service; the shape matters. */
function patch(raw: Record<string, unknown>): UpdateSettingsDto {
  return raw;
}

describe('settings registry', () => {
  it('does not expose a two-factor or IP-whitelist toggle', () => {
    // D-08 / D-09. A toggle reading "Two-Factor Authentication: on" while no
    // second factor is ever requested tells the operator they are protected
    // when they are not. It is absent, not disabled — a disabled control can be
    // re-enabled by someone who does not know why it was greyed out.
    const suspicious = SETTING_KEYS.filter((key) =>
      /twoFactor|2fa|ipWhitelist|ipAllow/i.test(key),
    );

    expect(suspicious).toEqual([]);
  });

  it('declares every key the update DTO accepts, and no more', () => {
    // The DTO enumerates keys so the global pipe can reject an unknown one; the
    // registry owns the bounds. This is what stops the two drifting apart.
    //
    // Checked one key at a time under the SAME `forbidNonWhitelisted` the
    // global pipe uses. Reading `Object.keys(plainToInstance(...))` instead
    // does NOT work: class-transformer copies unknown properties straight
    // through, so a key missing its DTO property still shows up and the guard
    // passes while `PUT /settings` rejects that key with 400. That gap let a
    // real bug reach the browser.
    for (const key of SETTING_KEYS) {
      const errors = validateSync(
        plainToInstance(UpdateSettingsDto, {
          [key]: SETTINGS_REGISTRY[key].default,
        }),
        { whitelist: true, forbidNonWhitelisted: true },
      );

      // A failure here names the key: it is in the registry but has no
      // property on UpdateSettingsDto, so PUT /settings answers 400 for it.
      expect({ key, rejected: errors.map((error) => error.property) }).toEqual({
        key,
        rejected: [],
      });
    }
  });

  it('accepts every registry default as a valid value for its own key', () => {
    for (const key of SETTING_KEYS) {
      expect(validateSettingValue(key, SETTINGS_REGISTRY[key].default)).toEqual(
        {
          valid: true,
          value: SETTINGS_REGISTRY[key].default,
        },
      );
    }
  });

  it.each([
    ['security.sessionTimeoutMinutes', 14, 'must be at least 15'],
    ['security.sessionTimeoutMinutes', 43201, 'must be at most 43200'],
    ['activity.retentionDays', 29, 'must be at least 30'],
    ['activity.retentionDays', 731, 'must be at most 730'],
    ['inventory.lowStockThreshold', -1, 'must be at least 0'],
    ['inventory.lowStockThreshold', 1001, 'must be at most 1000'],
  ] as [SettingKey, number, string][])(
    '%s rejects %s',
    (key, value, message) => {
      expect(validateSettingValue(key, value)).toEqual({
        valid: false,
        message,
      });
    },
  );

  it('rejects a non-integer where an integer is declared', () => {
    expect(validateSettingValue('activity.retentionDays', 90.5)).toEqual({
      valid: false,
      message: 'must be a whole number',
    });
  });

  it('rejects a value of the wrong type', () => {
    expect(validateSettingValue('notifications.dailySummary', 'yes')).toEqual({
      valid: false,
      message: 'must be true or false',
    });

    expect(validateSettingValue('company.name', 42)).toEqual({
      valid: false,
      message: 'must be a string',
    });
  });

  it('rejects a malformed email address', () => {
    expect(validateSettingValue('company.adminEmail', 'not-an-email')).toEqual({
      valid: false,
      message: 'must be a valid email address',
    });
  });

  it.each(['America/New_York', 'Europe/London', 'UTC'])(
    'accepts the IANA zone %s',
    (zone) => {
      expect(validateSettingValue('company.timezone', zone)).toEqual({
        valid: true,
        value: zone,
      });
    },
  );

  it.each(['Mars/Olympus_Mons', 'EST5EDT_NOPE', 'not a zone'])(
    'rejects %s as a timezone',
    (zone) => {
      expect(validateSettingValue('company.timezone', zone)).toEqual({
        valid: false,
        message: 'must be a valid IANA timezone',
      });
    },
  );

  it('trims a string value and refuses one that is only whitespace', () => {
    expect(validateSettingValue('company.name', '  Spades Co  ')).toEqual({
      valid: true,
      value: 'Spades Co',
    });

    expect(validateSettingValue('company.name', '   ')).toEqual({
      valid: false,
      message: 'must not be empty',
    });
  });

  it('refuses a company name longer than the declared maximum', () => {
    expect(validateSettingValue('company.name', 'x'.repeat(101))).toEqual({
      valid: false,
      message: 'must be at most 100 characters',
    });
  });
});

describe('UpdateSettingsDto', () => {
  it('reads the string "false" as false rather than true', () => {
    // enableImplicitConversion runs before @Transform and turns any non-empty
    // string into `true`. Without toBooleanFlag, switching a toggle off would
    // switch it on.
    const dto = plainToInstance(
      UpdateSettingsDto,
      { 'notifications.dailySummary': 'false' },
      { enableImplicitConversion: true },
    );

    expect(dto['notifications.dailySummary']).toBe(false);
    expect(validateSync(dto)).toEqual([]);
  });
});

describe('SettingsService', () => {
  let repository: MockedRepository;
  let activityLog: { record: jest.Mock };
  let service: SettingsService;

  const upserted = (): SettingUpsert[] =>
    (
      repository.upsertMany.mock.calls as [SettingUpsert[], string | null][]
    )[0]![0];

  const recorded = (): RecordActivityInput =>
    (activityLog.record.mock.calls as [RecordActivityInput][])[0]![0];

  beforeEach(() => {
    repository = {
      findAll: jest.fn().mockResolvedValue([] as StoredSetting[]),
      upsertMany: jest.fn().mockResolvedValue(undefined),
    };

    activityLog = { record: jest.fn().mockResolvedValue(undefined) };

    service = new SettingsService(
      repository as unknown as SettingsRepository,
      activityLog as unknown as ActivityLogService,
    );

    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // The threshold and retention window are process-wide; leaving one set
    // would make an unrelated suite fail on ordering.
    setLowStockThreshold(LOW_STOCK_THRESHOLD);
    setActivityRetentionDays(ACTIVITY_RETENTION_DAYS);
  });

  describe('reading', () => {
    it('returns the registry defaults when nothing is stored', async () => {
      await expect(service.getAll()).resolves.toEqual(defaultSettings());
    });

    it('overlays stored values on the defaults', async () => {
      repository.findAll.mockResolvedValue([
        { key: 'company.name', value: 'Spades Co' },
      ]);

      const snapshot = await service.getAll();

      expect(snapshot['company.name']).toBe('Spades Co');
      expect(snapshot['company.timezone']).toBe('America/New_York');
    });

    it('groups keys by the card they belong to', async () => {
      const grouped = await service.getGrouped();

      expect(Object.keys(grouped)).toEqual([
        'general',
        'notifications',
        'security',
      ]);
      expect(grouped.security).toEqual({
        'security.sessionTimeoutMinutes': 10080,
        'payouts.frozen': false,
        'activity.retentionDays': 180,
      });
    });

    it('ignores a stored key that is not in the registry', async () => {
      repository.findAll.mockResolvedValue([
        { key: 'security.twoFactorAuth', value: true },
      ]);

      const snapshot = await service.getAll();

      expect(snapshot).toEqual(defaultSettings());
      expect('security.twoFactorAuth' in snapshot).toBe(false);
    });

    it('falls back to the default when a stored value fails its own check', async () => {
      repository.findAll.mockResolvedValue([
        { key: 'security.sessionTimeoutMinutes', value: 1 },
      ]);

      const snapshot = await service.getAll();

      expect(snapshot['security.sessionTimeoutMinutes']).toBe(10080);
    });

    it('reads the table once and serves the rest from cache', async () => {
      await service.getAll();
      await service.getAll();
      await service.getSessionTimeoutMinutes();

      expect(repository.findAll).toHaveBeenCalledTimes(1);
    });

    it('reads the table again after the cache is invalidated', async () => {
      await service.getAll();
      service.invalidate();
      await service.getAll();

      expect(repository.findAll).toHaveBeenCalledTimes(2);
    });
  });

  describe('applying', () => {
    it('pushes the stored threshold and retention window into their consumers', async () => {
      repository.findAll.mockResolvedValue([
        { key: 'inventory.lowStockThreshold', value: 25 },
        { key: 'activity.retentionDays', value: 365 },
      ]);

      await service.getAll();

      expect(getLowStockThreshold()).toBe(25);
      expect(getActivityRetentionDays()).toBe(365);
    });

    it('applies a saved threshold without waiting for the next read', async () => {
      repository.findAll
        .mockResolvedValueOnce([])
        .mockResolvedValue([{ key: 'inventory.lowStockThreshold', value: 20 }]);

      await service.update(
        patch({ 'inventory.lowStockThreshold': 20 }),
        'admin-1',
      );

      expect(getLowStockThreshold()).toBe(20);
    });
  });

  describe('update', () => {
    it('rejects an unknown key with 400 and writes nothing', async () => {
      await expect(
        service.update(patch({ 'company.mascot': 'a spade' }), 'admin-1'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(repository.upsertMany).not.toHaveBeenCalled();
    });

    it('names the offending key in the 400', async () => {
      await expect(
        service.update(patch({ 'company.mascot': 'a spade' }), 'admin-1'),
      ).rejects.toMatchObject({
        response: {
          details: [
            { field: 'company.mascot', message: 'is not a known setting' },
          ],
        },
      });
    });

    it('rejects a value outside its declared bounds', async () => {
      await expect(
        service.update(
          patch({ 'security.sessionTimeoutMinutes': 5 }),
          'admin-1',
        ),
      ).rejects.toMatchObject({
        response: {
          details: [
            {
              field: 'security.sessionTimeoutMinutes',
              message: 'must be at least 15',
            },
          ],
        },
      });
    });

    it('reports every invalid key at once', async () => {
      await expect(
        service.update(
          patch({
            'security.sessionTimeoutMinutes': 5,
            'company.adminEmail': 'nope',
          }),
          'admin-1',
        ),
      ).rejects.toMatchObject({
        response: {
          details: [
            expect.objectContaining({
              field: 'security.sessionTimeoutMinutes',
            }),
            expect.objectContaining({ field: 'company.adminEmail' }),
          ],
        },
      });
    });

    it('writes nothing at all when one key of several is invalid', async () => {
      await expect(
        service.update(
          patch({ 'company.name': 'Fine', 'activity.retentionDays': 1 }),
          'admin-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(repository.upsertMany).not.toHaveBeenCalled();
    });

    it('writes only the keys supplied, leaving the rest untouched', async () => {
      const result = await service.update(
        patch({ 'company.name': 'Spades Co' }),
        'admin-1',
      );

      expect(upserted()).toEqual([
        expect.objectContaining({
          key: 'company.name',
          value: 'Spades Co',
          category: 'general',
        }),
      ]);

      // Everything else still reads at its default.
      expect(result.general['company.timezone']).toBe('America/New_York');
      expect(result.security['activity.retentionDays']).toBe(180);
    });

    it('invalidates the cache so the next read sees the new value', async () => {
      await service.getAll();
      expect(repository.findAll).toHaveBeenCalledTimes(1);

      repository.findAll.mockResolvedValue([
        { key: 'company.name', value: 'Spades Co' },
      ]);

      const result = await service.update(
        patch({ 'company.name': 'Spades Co' }),
        'admin-1',
      );

      expect(repository.findAll).toHaveBeenCalledTimes(2);
      expect(result.general['company.name']).toBe('Spades Co');
    });

    it('does not write a key whose value did not move', async () => {
      repository.findAll.mockResolvedValue([
        { key: 'company.name', value: 'Spades Co' },
      ]);

      await service.update(patch({ 'company.name': 'Spades Co' }), 'admin-1');

      expect(repository.upsertMany).not.toHaveBeenCalled();
      expect(activityLog.record).not.toHaveBeenCalled();
    });

    it('records the change with a before/after diff', async () => {
      repository.findAll
        .mockResolvedValueOnce([])
        .mockResolvedValue([
          { key: 'security.sessionTimeoutMinutes', value: 60 },
        ]);

      await service.update(
        patch({ 'security.sessionTimeoutMinutes': 60 }),
        'admin-1',
      );

      expect(recorded()).toMatchObject({
        action: 'settings.updated',
        adminId: 'admin-1',
        metadata: {
          keys: ['security.sessionTimeoutMinutes'],
          changes: {
            'security.sessionTimeoutMinutes': { from: 10080, to: 60 },
          },
        },
      });
    });

    it('stores a trimmed string, not the raw one', async () => {
      await service.update(
        patch({ 'company.name': '  Spades Co ' }),
        'admin-1',
      );

      expect(upserted()[0]?.value).toBe('Spades Co');
    });

    it('ignores properties explicitly set to undefined', async () => {
      await service.update(
        patch({ 'company.name': undefined, 'activity.retentionDays': 200 }),
        'admin-1',
      );

      expect(upserted()).toHaveLength(1);
      expect(upserted()[0]?.key).toBe('activity.retentionDays');
    });
  });
});
