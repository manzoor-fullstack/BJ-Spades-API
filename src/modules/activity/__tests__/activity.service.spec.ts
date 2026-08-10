import { Logger } from '@nestjs/common';
import { ActivityCategory } from '@prisma/client';
import { plainToInstance } from 'class-transformer';

import { computeDiff } from '../../../common/audit/compute-diff.util';
import {
  isSensitiveKey,
  sanitizeMetadata,
  SENSITIVE_METADATA_KEYS,
} from '../../../common/audit/metadata-sanitizer.util';
import {
  ACTIVITY_ACTIONS,
  activityActionTitle,
  isHighPriorityAction,
} from '../../../common/constants/activity-actions';
import {
  ACTIVITY_RETENTION_DAYS,
  ActivityLogService,
} from '../activity.service';
import { QueryActivityDto } from '../dto/query-activity.dto';
import type {
  ActivityLogRepository,
  CreateActivityLogData,
  ListActivityArgs,
} from '../repositories/activity.repository';

type MockedRepository = { [K in keyof ActivityLogRepository]: jest.Mock };

/** `jest.Mock.mock.calls` is `any[][]`; this keeps the assertions typed. */
function callsOf<T extends unknown[]>(mock: { mock: { calls: T[] } }): T[] {
  return mock.mock.calls;
}

function query(raw: Record<string, unknown> = {}): QueryActivityDto {
  return plainToInstance(QueryActivityDto, raw, {
    enableImplicitConversion: true,
  });
}

const ROW = {
  id: 'log-1',
  category: ActivityCategory.USER,
  action: 'user.created',
  title: 'New user Ada Lovelace created',
  description: null,
  adminId: 'admin-1',
  admin: { id: 'admin-1', firstName: 'Super', lastName: 'Admin' },
  entityType: 'User',
  entityId: 'user-1',
  metadata: null,
  ipAddress: '127.0.0.1',
  userAgent: 'jest',
  isHighPriority: false,
  createdAt: new Date('2026-08-04T09:12:00.000Z'),
};

describe('activity action catalogue', () => {
  // The exact sentence stored on the row when a caller composes none. Spelled
  // out rather than derived, so a silent edit to a title shows up as a failure.
  const EXPECTED_TITLES: Record<string, string> = {
    'auth.login': 'Admin signed in',
    'auth.login_failed': 'Failed sign-in attempt',
    'auth.logout': 'Admin signed out',
    'auth.logout_all': 'Admin signed out of all other sessions',
    'auth.session_revoked': 'Session revoked',
    'auth.token_reuse_detected': 'Refresh token reuse detected',
    'user.created': 'User created',
    'user.updated': 'User updated',
    'user.suspended': 'User suspended',
    'user.activated': 'User activated',
    'user.deleted': 'User deleted',
    'user.balance_adjusted': 'User balance adjusted',
    'admin.created': 'Administrator created',
    'admin.updated': 'Administrator updated',
    'admin.deleted': 'Administrator deleted',
    'admin.activated': 'Administrator activated',
    'admin.deactivated': 'Administrator deactivated',
    'admin.role_changed': 'Administrator role changed',
    'role.created': 'Role created',
    'role.updated': 'Role updated',
    'role.deleted': 'Role deleted',
    'role.permissions_changed': 'Role permissions changed',
    'tournament.created': 'Tournament created',
    'tournament.updated': 'Tournament updated',
    'tournament.cancelled': 'Tournament cancelled',
    'tournament.deleted': 'Tournament deleted',
    'tournament.player_registered': 'Player registered for tournament',
    'tournament.player_removed': 'Player removed from tournament',
    'tournament.results_submitted': 'Tournament results submitted',
    'reward.created': 'Reward created',
    'reward.updated': 'Reward updated',
    'reward.deleted': 'Reward deleted',
    'merchandise.created': 'Merchandise created',
    'merchandise.updated': 'Merchandise updated',
    'merchandise.deleted': 'Merchandise deleted',
    'merchandise.variant_added': 'Merchandise variant added',
    'merchandise.variant_updated': 'Merchandise variant updated',
    'merchandise.variant_removed': 'Merchandise variant removed',
    'payout.approved': 'Payout approved',
    'payout.processed': 'Payout processed',
    'payout.cancelled': 'Payout cancelled',
    'claim.approved': 'Prize claim approved',
    'claim.declined': 'Prize claim declined',
    'dispute.cleared': 'Dispute cleared',
    'dispute.disqualified': 'Player disqualified',
    'payout.failed': 'Payout failed',
    'payout.stripe_onboarding_started': 'Stripe onboarding link generated',
    'payout.stripe_account_updated': 'Stripe account status updated',
    'transaction.balance_adjusted': 'Ledger balance adjusted',
    'settings.updated': 'Settings updated',
    'security.session_revoked': 'Session revoked by an administrator',
    'webhook.user_created': 'User registered via webhook',
    'webhook.failed': 'Webhook processing failed',
  };

  const HIGH_PRIORITY_CODES = [
    'auth.login_failed',
    'auth.session_revoked',
    'auth.token_reuse_detected',
    'user.suspended',
    'user.deleted',
    'user.balance_adjusted',
    // Everything that hands out, moves, or removes admin access.
    'admin.created',
    'admin.deleted',
    'admin.activated',
    'admin.deactivated',
    'admin.role_changed',
    'role.deleted',
    'role.permissions_changed',
    // Cancellation refunds entry fees from Phase 6; deletion cascades to every
    // registration. Both are destructive in a way the other tournament events
    // are not.
    'tournament.cancelled',
    'tournament.deleted',
    // Both catalogue deletes remove an offer players may already have seen.
    // `merchandise.variant_removed` joins them because a variant has no
    // `deletedAt` — it is a hard delete that takes its SKU and stock with it.
    'reward.deleted',
    'merchandise.deleted',
    'merchandise.variant_removed',
    // Every payout and ledger event without exception: these are the only rows
    // that correspond to money moving, and a wrong transfer is unrecoverable.
    'payout.approved',
    'payout.processed',
    'payout.cancelled',
    'claim.approved',
    'claim.declined',
    'dispute.cleared',
    'dispute.disqualified',
    'payout.failed',
    'payout.stripe_onboarding_started',
    'payout.stripe_account_updated',
    'transaction.balance_adjusted',
    // A settings change alters how the platform behaves — how long a session
    // lives, how long the audit trail itself is kept. A revocation ends
    // someone's access. Both belong in the feed the security page reads.
    'settings.updated',
    'security.session_revoked',
    'webhook.failed',
  ];

  /**
   * Codes whose prefix is not their category.
   *
   * `ActivityCategory` has no ROLE member and Phase 3 changes no schema, so role
   * events are filed under ADMIN — which is also where an operator would look
   * for them.
   */
  const CATEGORY_EXCEPTIONS: Record<string, ActivityCategory> = {
    'role.created': ActivityCategory.ADMIN,
    'role.updated': ActivityCategory.ADMIN,
    'role.deleted': ActivityCategory.ADMIN,
    'role.permissions_changed': ActivityCategory.ADMIN,
    // ActivityCategory has no TRANSACTION member and Phase 6 changes no schema,
    // so ledger events are filed under PAYOUT — the money category, and where an
    // operator chasing a balance movement would look.
    'transaction.balance_adjusted': ActivityCategory.PAYOUT,
    // Same reasoning: ActivityCategory has no CLAIM or DISPUTE member. Both
    // decide whether money is owed at all, so they are filed under PAYOUT —
    // where an operator tracing why a player was or was not paid would look.
    'claim.approved': ActivityCategory.PAYOUT,
    'claim.declined': ActivityCategory.PAYOUT,
    'dispute.cleared': ActivityCategory.PAYOUT,
    'dispute.disqualified': ActivityCategory.PAYOUT,
  };

  it('every catalogued code produces the expected title', () => {
    for (const definition of Object.values(ACTIVITY_ACTIONS)) {
      expect(activityActionTitle(definition.code)).toBe(
        EXPECTED_TITLES[definition.code],
      );
    }
  });

  it('covers every code in the catalogue and no more', () => {
    const codes = Object.values(ACTIVITY_ACTIONS)
      .map((definition) => definition.code)
      .sort();

    expect(codes).toEqual(Object.keys(EXPECTED_TITLES).sort());
  });

  it('flags exactly the high-priority actions', () => {
    const flagged = Object.values(ACTIVITY_ACTIONS)
      .filter((definition) => definition.isHighPriority)
      .map((definition) => definition.code)
      .sort();

    expect(flagged).toEqual([...HIGH_PRIORITY_CODES].sort());
  });

  it.each(HIGH_PRIORITY_CODES)('%s is high priority', (code) => {
    expect(isHighPriorityAction(code)).toBe(true);
  });

  it.each(['auth.login', 'user.created', 'webhook.user_created'])(
    '%s is routine',
    (code) => {
      expect(isHighPriorityAction(code)).toBe(false);
    },
  );

  it('categorises each code by prefix, bar the documented exceptions', () => {
    for (const definition of Object.values(ACTIVITY_ACTIONS)) {
      const expected =
        CATEGORY_EXCEPTIONS[definition.code] ??
        definition.code.split('.')[0]?.toUpperCase();

      expect(definition.category).toBe(expected);
    }
  });

  it('falls back to the raw code for an uncatalogued action', () => {
    expect(activityActionTitle('nope.unknown')).toBe('nope.unknown');
    expect(isHighPriorityAction('nope.unknown')).toBe(false);
  });
});

describe('metadata denylist', () => {
  it.each(SENSITIVE_METADATA_KEYS)('strips a top-level %s', (key) => {
    expect(sanitizeMetadata({ [key]: 'secret', keep: 'yes' })).toEqual({
      keep: 'yes',
    });
  });

  it('recurses into nested objects', () => {
    const sanitized = sanitizeMetadata({
      admin: {
        email: 'admin@bjspades.com',
        password: 'Admin123!',
        session: { tokenHash: 'abc', refreshToken: 'def', id: 'session-1' },
      },
    });

    expect(sanitized).toEqual({
      admin: {
        email: 'admin@bjspades.com',
        session: { id: 'session-1' },
      },
    });
  });

  it('recurses into objects inside arrays', () => {
    expect(
      sanitizeMetadata({
        items: [
          { id: 1, secret: 'a' },
          { id: 2, authorization: 'Bearer x' },
        ],
      }),
    ).toEqual({ items: [{ id: 1 }, { id: 2 }] });
  });

  it('matches denied keys case-insensitively', () => {
    expect(
      sanitizeMetadata({ Password: 'x', REFRESHTOKEN: 'y', ok: 1 }),
    ).toEqual({ ok: 1 });
  });

  it('does not strip keys that merely contain a denied word', () => {
    expect(sanitizeMetadata({ passwordChangedAt: '2026-01-01' })).toEqual({
      passwordChangedAt: '2026-01-01',
    });
  });

  it('renders dates as ISO strings', () => {
    expect(
      sanitizeMetadata({ at: new Date('2026-08-04T09:12:00.000Z') }),
    ).toEqual({ at: '2026-08-04T09:12:00.000Z' });
  });

  it('survives a circular reference instead of throwing', () => {
    const node: Record<string, unknown> = { id: 'a' };
    node.self = node;

    expect(() => sanitizeMetadata(node)).not.toThrow();
    expect(sanitizeMetadata(node)).toEqual({ id: 'a', self: '[circular]' });
  });

  it('returns undefined when nothing is left worth storing', () => {
    expect(sanitizeMetadata({ password: 'x' })).toBeUndefined();
    expect(sanitizeMetadata(undefined)).toBeUndefined();
    expect(sanitizeMetadata({})).toBeUndefined();
  });

  it('recognises denied keys directly', () => {
    expect(isSensitiveKey('Token')).toBe(true);
    expect(isSensitiveKey('email')).toBe(false);
  });
});

describe('computeDiff', () => {
  it('records only the fields that changed', () => {
    expect(
      computeDiff(
        { status: 'ACTIVE', tier: 'PLAYER', email: 'a@b.c' },
        { status: 'SUSPENDED', tier: 'PLAYER', email: 'a@b.c' },
      ),
    ).toEqual({ status: { from: 'ACTIVE', to: 'SUSPENDED' } });
  });

  it('returns an empty diff when nothing moved', () => {
    expect(computeDiff({ a: 1 }, { a: 1 })).toEqual({});
  });

  it('reports a newly set field with a null "from"', () => {
    expect(computeDiff({}, { city: 'Lagos' })).toEqual({
      city: { from: null, to: 'Lagos' },
    });
  });

  it('ignores fields absent from the after state', () => {
    expect(computeDiff({ a: 1, b: 2 }, { a: 9 })).toEqual({
      a: { from: 1, to: 9 },
    });
  });

  it('compares nested structures by value, not identity', () => {
    expect(computeDiff({ tags: ['a'] }, { tags: ['a'] })).toEqual({});
    expect(computeDiff({ tags: ['a'] }, { tags: ['a', 'b'] })).toEqual({
      tags: { from: ['a'], to: ['a', 'b'] },
    });
  });

  it('never diffs a denylisted field', () => {
    expect(computeDiff({ password: 'old' }, { password: 'new' })).toEqual({});
  });

  it('treats a non-object after state as no change', () => {
    expect(computeDiff({ a: 1 }, null)).toEqual({});
  });
});

describe('ActivityLogService', () => {
  let repository: MockedRepository;
  let service: ActivityLogService;

  beforeEach(() => {
    repository = {
      create: jest.fn().mockResolvedValue(undefined),
      findMany: jest.fn().mockResolvedValue([ROW]),
      count: jest.fn().mockResolvedValue(1),
      findRecent: jest.fn().mockResolvedValue([ROW]),
      deleteOlderThan: jest.fn().mockResolvedValue(0),
    };

    service = new ActivityLogService(
      repository as unknown as ActivityLogRepository,
    );

    // The failure paths deliberately log; keep the suite output readable.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const created = (): CreateActivityLogData =>
    callsOf<[CreateActivityLogData]>(repository.create)[0]![0];

  describe('record', () => {
    it('falls back to the catalogue title and priority', async () => {
      await service.record({
        category: ActivityCategory.USER,
        action: ACTIVITY_ACTIONS.USER_SUSPENDED.code,
      });

      expect(created().title).toBe('User suspended');
      expect(created().isHighPriority).toBe(true);
    });

    it('prefers a composed title over the catalogue default', async () => {
      await service.record({
        category: ActivityCategory.USER,
        action: ACTIVITY_ACTIONS.USER_CREATED.code,
        title: 'New user Ada Lovelace created',
      });

      expect(created().title).toBe('New user Ada Lovelace created');
    });

    it('honours an explicit priority override', async () => {
      await service.record({
        category: ActivityCategory.USER,
        action: ACTIVITY_ACTIONS.USER_CREATED.code,
        isHighPriority: true,
      });

      expect(created().isHighPriority).toBe(true);
    });

    it('strips denylisted keys before writing', async () => {
      await service.record({
        category: ActivityCategory.AUTH,
        action: ACTIVITY_ACTIONS.AUTH_LOGIN.code,
        metadata: {
          email: 'admin@bjspades.com',
          password: 'Admin123!',
          nested: { refreshToken: 'r', keep: true },
        },
      });

      expect(created().metadata).toEqual({
        email: 'admin@bjspades.com',
        nested: { keep: true },
      });
    });

    it('normalises absent optional fields to null', async () => {
      await service.record({
        category: ActivityCategory.AUTH,
        action: ACTIVITY_ACTIONS.AUTH_LOGIN_FAILED.code,
      });

      expect(created()).toMatchObject({
        description: null,
        adminId: null,
        entityId: null,
        ipAddress: null,
        userAgent: null,
      });
      expect(created().metadata).toBeUndefined();
    });

    // The rule from PHASE-2: losing an audit row is bad, failing a successful
    // mutation because the audit row could not be written is worse.
    it('does not propagate a write failure to the caller', async () => {
      repository.create.mockRejectedValue(new Error('database is on fire'));

      await expect(
        service.record({
          category: ActivityCategory.USER,
          action: ACTIVITY_ACTIONS.USER_CREATED.code,
        }),
      ).resolves.toBeUndefined();
    });

    it('reports a swallowed failure to the application logger', async () => {
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      repository.create.mockRejectedValue(new Error('database is on fire'));

      await service.record({
        category: ActivityCategory.USER,
        action: ACTIVITY_ACTIONS.USER_CREATED.code,
      });

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('database is on fire'),
      );
    });
  });

  describe('findAll', () => {
    const args = (): ListActivityArgs =>
      callsOf<[ListActivityArgs]>(repository.findMany)[0]![0];

    it('serialises rows with the admin summary and an ISO timestamp', async () => {
      const page = await service.findAll(query());

      expect(page.data).toEqual([
        {
          id: 'log-1',
          category: ActivityCategory.USER,
          action: 'user.created',
          title: 'New user Ada Lovelace created',
          description: null,
          admin: { id: 'admin-1', fullName: 'Super Admin' },
          entityType: 'User',
          entityId: 'user-1',
          isHighPriority: false,
          createdAt: '2026-08-04T09:12:00.000Z',
        },
      ]);
      expect(page.meta).toEqual({
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
    });

    it('reports a deleted admin as null rather than dropping the row', async () => {
      repository.findMany.mockResolvedValue([
        { ...ROW, adminId: null, admin: null },
      ]);

      const page = await service.findAll(query());

      expect(page.data[0]?.admin).toBeNull();
    });

    it('defaults to newest first', async () => {
      await service.findAll(query());

      expect(args().sortBy).toBe('createdAt');
      expect(args().sortOrder).toBe('desc');
    });

    it('refuses a sort field that is not allowlisted', async () => {
      await service.findAll(query({ sortBy: 'admin.password' }));

      expect(args().sortBy).toBe('createdAt');
    });

    it('passes every filter through to the repository', async () => {
      await service.findAll(
        query({
          category: ActivityCategory.AUTH,
          adminId: '11111111-1111-4111-8111-111111111111',
          entityType: 'User',
          entityId: 'user-1',
          isHighPriority: true,
          search: '  fraud  ',
        }),
      );

      expect(args().filter).toMatchObject({
        category: ActivityCategory.AUTH,
        adminId: '11111111-1111-4111-8111-111111111111',
        entityType: 'User',
        entityId: 'user-1',
        isHighPriority: true,
        search: 'fraud',
      });
    });

    it('expands a bare date range to cover both whole days', async () => {
      await service.findAll(query({ from: '2026-08-01', to: '2026-08-04' }));

      expect(args().filter.from?.toISOString()).toBe(
        '2026-08-01T00:00:00.000Z',
      );
      expect(args().filter.to?.toISOString()).toBe('2026-08-04T23:59:59.999Z');
    });

    it('leaves an explicit timestamp alone', async () => {
      await service.findAll(query({ to: '2026-08-04T09:12:00.000Z' }));

      expect(args().filter.to?.toISOString()).toBe('2026-08-04T09:12:00.000Z');
    });
  });

  describe('findRecent', () => {
    it('asks the repository for exactly the requested count', async () => {
      await service.findRecent(5);

      expect(repository.findRecent).toHaveBeenCalledWith(5);
    });
  });

  describe('pruneOlderThan', () => {
    it('defaults to the 180-day retention window', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-04T00:00:00.000Z'));

      await service.pruneOlderThan();

      const [cutoff] = callsOf<[Date]>(repository.deleteOlderThan)[0]!;

      expect(ACTIVITY_RETENTION_DAYS).toBe(180);
      expect(cutoff.toISOString()).toBe('2026-02-05T00:00:00.000Z');

      jest.useRealTimers();
    });

    it('returns how many rows went', async () => {
      repository.deleteOlderThan.mockResolvedValue(42);

      await expect(service.pruneOlderThan(30)).resolves.toBe(42);
    });
  });
});
