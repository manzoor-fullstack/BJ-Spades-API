import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  Prisma,
  RegistrationStatus,
  TournamentStatus,
  UserStatus,
  UserTier,
} from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import type { AuthenticatedAdmin } from '../../auth/interfaces/authenticated-admin.interface';
import type { MediaService } from '../../storage/media.service';
import type { UsersRepository } from '../../users/repositories/users.repository';
import { CancelTournamentDto } from '../dto/cancel-tournament.dto';
import { CreateTournamentDto } from '../dto/create-tournament.dto';
import type {
  RegistrationOutcome,
  TournamentsRepository,
  TournamentWithRelations,
} from '../repositories/tournaments.repository';
import { combineStartsAt } from '../start-time.util';
import { ALLOWED_TRANSITIONS } from '../tournament-status';
import { TournamentsService } from '../tournaments.service';

type MockedTournaments = { [K in keyof TournamentsRepository]: jest.Mock };
type MockedUsers = { [K in keyof UsersRepository]: jest.Mock };
type MockedMedia = { [K in keyof MediaService]: jest.Mock };

const ADMIN: AuthenticatedAdmin = {
  id: 'admin-1',
  email: 'admin@bjspades.com',
  role: 'SUPER_ADMIN',
  roleId: 'role-1',
  sessionId: 'session-1',
};

const TOURNAMENT_ID = '11111111-1111-4111-8111-000000000001';
const USER_ID = '22222222-2222-4222-8222-000000000001';

const ALL_STATUSES = Object.values(TournamentStatus);

function tournamentFixture(
  overrides: Partial<TournamentWithRelations> = {},
): TournamentWithRelations {
  return {
    id: TOURNAMENT_ID,
    name: 'Friday Night Spades',
    description: null,
    imageId: null,
    image: null,
    entryFee: new Prisma.Decimal('10.00'),
    prizePool: new Prisma.Decimal('500.00'),
    maxPlayers: 16,
    startsAt: new Date('2026-06-05T23:00:00.000Z'),
    status: TournamentStatus.REGISTERING,
    cancelledAt: null,
    cancelReason: null,
    createdByAdminId: ADMIN.id,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    _count: { registrations: 0 },
    ...overrides,
  };
}

function userFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    status: UserStatus.ACTIVE,
    tier: UserTier.PLAYER,
    deletedAt: null,
    ...overrides,
  };
}

function registrationFixture() {
  return {
    id: 'registration-1',
    tournamentId: TOURNAMENT_ID,
    userId: USER_ID,
    status: RegistrationStatus.REGISTERED,
    placement: null,
    prizeWon: null,
    registeredAt: new Date('2026-05-02T00:00:00.000Z'),
    // Added by the Phase 6 schema: a registration can be linked to its payout.
    payoutId: null,
    user: userFixture(),
  };
}

function createDto(
  overrides: Partial<CreateTournamentDto> = {},
): CreateTournamentDto {
  return plainToInstance(CreateTournamentDto, {
    name: 'Friday Night Spades',
    maxPlayers: 16,
    startDate: '2026-05-30',
    startTime: '20:00',
    ...overrides,
  });
}

describe('TournamentsService', () => {
  let repository: MockedTournaments;
  let users: MockedUsers;
  let media: MockedMedia;
  let service: TournamentsService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn(),
      count: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      countByStatus: jest.fn(),
      sumPrizePool: jest.fn(),
      countAll: jest.fn(),
      countAllRegistrations: jest.fn(),
      findRegistrations: jest.fn(),
      countRegistrations: jest.fn(),
      findRegistration: jest.fn(),
      createRegistration: jest.fn(),
      deleteRegistration: jest.fn(),
      submitResults: jest.fn(),
      // Phase 6: cancelling refunds every entry fee in the same transaction
      // as the status change, so `cancel` no longer goes through `update`.
      cancelWithRefunds: jest.fn(),
    };

    users = {
      findById: jest.fn(),
    } as unknown as MockedUsers;

    media = {
      uploadImage: jest.fn(),
      deleteAsset: jest.fn().mockResolvedValue(undefined),
      cleanupOrphans: jest.fn(),
    };

    service = new TournamentsService(
      repository as unknown as TournamentsRepository,
      users as unknown as UsersRepository,
      media as unknown as MediaService,
    );
  });

  describe('start time', () => {
    it('combines the separate date and time fields into a UTC instant', async () => {
      repository.create.mockImplementation((data: { startsAt: Date }) =>
        Promise.resolve(tournamentFixture({ startsAt: data.startsAt })),
      );

      await service.create(
        createDto({ startDate: '2026-05-30', startTime: '20:00' }),
        undefined,
        ADMIN,
      );

      const [data] = repository.create.mock.calls[0] as [{ startsAt: Date }];

      expect(data.startsAt.toISOString()).toBe('2026-05-30T20:00:00.000Z');
      expect(data.startsAt.getTime()).toBe(Date.UTC(2026, 4, 30, 20, 0, 0));
    });

    it('is not affected by the server timezone', () => {
      // The failure this guards against is silent: `new Date('2026-05-30T20:00')`
      // is parsed as server-local time, so the same input produces a different
      // instant on a machine in another region.
      const startsAt = combineStartsAt('2026-05-30', '20:00');

      expect(startsAt.getUTCHours()).toBe(20);
      expect(startsAt.getUTCDate()).toBe(30);
      expect(startsAt.toISOString()).toBe('2026-05-30T20:00:00.000Z');
    });

    it('rejects a well-formed but non-existent date', () => {
      expect(() => combineStartsAt('2026-02-31', '20:00')).toThrow(
        UnprocessableEntityException,
      );
    });

    it('defaults a new tournament to SCHEDULED', async () => {
      repository.create.mockResolvedValue(tournamentFixture());

      await service.create(createDto(), undefined, ADMIN);

      const [data] = repository.create.mock.calls[0] as [
        { status: TournamentStatus },
      ];

      expect(data.status).toBe(TournamentStatus.SCHEDULED);
    });

    it('stores money as a Decimal, never a float', async () => {
      repository.create.mockResolvedValue(tournamentFixture());

      await service.create(
        createDto({ entryFee: '25.50', prizePool: '1000.00' }),
        undefined,
        ADMIN,
      );

      const [data] = repository.create.mock.calls[0] as [
        { entryFee: Prisma.Decimal; prizePool: Prisma.Decimal },
      ];

      expect(data.entryFee.toFixed(2)).toBe('25.50');
      expect(data.prizePool.toFixed(2)).toBe('1000.00');
    });
  });

  describe('creation status', () => {
    it.each([TournamentStatus.SCHEDULED, TournamentStatus.REGISTERING])(
      'accepts %s at creation',
      (status) => {
        const errors = validateSync(createDto({ status }));

        expect(errors).toHaveLength(0);
      },
    );

    it.each([
      TournamentStatus.IN_PROGRESS,
      TournamentStatus.COMPLETED,
      TournamentStatus.CANCELLED,
    ])('refuses to create a tournament already %s', (status) => {
      const errors = validateSync(createDto({ status }));

      expect(errors).not.toHaveLength(0);
      expect(errors.map((error) => error.property)).toContain('status');
    });
  });

  describe('status transitions', () => {
    /** Every ordered pair of distinct statuses, split by the transition table. */
    const pairs = ALL_STATUSES.flatMap((from) =>
      ALL_STATUSES.filter((to) => to !== from).map((to) => ({ from, to })),
    );

    const illegal = pairs.filter(
      ({ from, to }) => !ALLOWED_TRANSITIONS[from].includes(to),
    );

    const legal = pairs.filter(({ from, to }) =>
      ALLOWED_TRANSITIONS[from].includes(to),
    );

    it('covers the whole matrix', () => {
      expect(legal).toHaveLength(6);
      expect(illegal).toHaveLength(14);
    });

    it.each(illegal)('rejects $from -> $to with 422', async ({ from, to }) => {
      repository.findById.mockResolvedValue(
        tournamentFixture({ status: from }),
      );

      await expect(
        service.update(TOURNAMENT_ID, { status: to }, undefined, ADMIN),
      ).rejects.toThrow(UnprocessableEntityException);

      expect(repository.update).not.toHaveBeenCalled();
    });

    it.each(illegal.filter(({ from }) => ALLOWED_TRANSITIONS[from].length > 0))(
      'names the allowed set when rejecting $from -> $to',
      async ({ from, to }) => {
        repository.findById.mockResolvedValue(
          tournamentFixture({ status: from }),
        );

        await expect(
          service.update(TOURNAMENT_ID, { status: to }, undefined, ADMIN),
        ).rejects.toThrow(
          new RegExp(`Allowed from ${from}: .*${ALLOWED_TRANSITIONS[from][0]}`),
        );
      },
    );

    it.each(
      illegal.filter(({ from }) => ALLOWED_TRANSITIONS[from].length === 0),
    )(
      'reports $from as final when rejecting $from -> $to',
      async ({ from, to }) => {
        repository.findById.mockResolvedValue(
          tournamentFixture({ status: from }),
        );

        await expect(
          service.update(TOURNAMENT_ID, { status: to }, undefined, ADMIN),
        ).rejects.toThrow(/is final and cannot change status/);
      },
    );

    it.each(legal)('allows $from -> $to', async ({ from, to }) => {
      repository.findById.mockResolvedValue(
        tournamentFixture({ status: from }),
      );
      repository.update.mockResolvedValue(tournamentFixture({ status: to }));

      await expect(
        service.update(TOURNAMENT_ID, { status: to }, undefined, ADMIN),
      ).resolves.toMatchObject({ status: to });
    });

    it.each(ALL_STATUSES)(
      're-submitting the current status (%s) is a no-op, not a transition',
      async (status) => {
        repository.findById.mockResolvedValue(tournamentFixture({ status }));
        repository.update.mockResolvedValue(tournamentFixture({ status }));

        await expect(
          service.update(TOURNAMENT_ID, { status }, undefined, ADMIN),
        ).resolves.toMatchObject({ status });
      },
    );
  });

  describe('cancel', () => {
    it('requires a reason', () => {
      const errors = validateSync(plainToInstance(CancelTournamentDto, {}));

      expect(errors.map((error) => error.property)).toContain('reason');
    });

    it.each(['', '  ', 'ab'])('rejects %p as a reason', (reason) => {
      const errors = validateSync(
        plainToInstance(CancelTournamentDto, { reason }),
      );

      expect(errors).not.toHaveLength(0);
    });

    it('sets status, cancelledAt and cancelReason together', async () => {
      repository.findById.mockResolvedValue(tournamentFixture());
      repository.cancelWithRefunds.mockResolvedValue(
        tournamentFixture({
          status: TournamentStatus.CANCELLED,
          cancelledAt: new Date('2026-05-03T00:00:00.000Z'),
          cancelReason: 'Venue unavailable',
        }),
      );

      await service.cancel(TOURNAMENT_ID, { reason: '  Venue unavailable  ' });

      const [, data] = repository.cancelWithRefunds.mock.calls[0] as [
        string,
        { status: TournamentStatus; cancelledAt: Date; cancelReason: string },
      ];

      expect(data.status).toBe(TournamentStatus.CANCELLED);
      expect(data.cancelledAt).toBeInstanceOf(Date);
      expect(data.cancelReason).toBe('Venue unavailable');
    });

    it.each([TournamentStatus.COMPLETED, TournamentStatus.CANCELLED])(
      'refuses to cancel a %s tournament',
      async (status) => {
        repository.findById.mockResolvedValue(tournamentFixture({ status }));

        await expect(
          service.cancel(TOURNAMENT_ID, { reason: 'Changed my mind' }),
        ).rejects.toThrow(UnprocessableEntityException);
      },
    );
  });

  describe('registration', () => {
    beforeEach(() => {
      repository.findById.mockResolvedValue(tournamentFixture());
      users.findById.mockResolvedValue(userFixture());
    });

    it('registers an active user into a REGISTERING tournament', async () => {
      repository.createRegistration.mockResolvedValue({
        outcome: 'CREATED',
        registration: registrationFixture(),
      } satisfies RegistrationOutcome);

      await expect(
        service.registerPlayer(TOURNAMENT_ID, { userId: USER_ID }),
      ).resolves.toMatchObject({ userId: USER_ID, user: { initials: 'AL' } });
    });

    it('throws 422 when the tournament is full', async () => {
      repository.createRegistration.mockResolvedValue({
        outcome: 'FULL',
        registeredCount: 16,
        maxPlayers: 16,
      } satisfies RegistrationOutcome);

      await expect(
        service.registerPlayer(TOURNAMENT_ID, { userId: USER_ID }),
      ).rejects.toThrow(UnprocessableEntityException);
      await expect(
        service.registerPlayer(TOURNAMENT_ID, { userId: USER_ID }),
      ).rejects.toThrow(/full: 16 of 16/);
    });

    it.each([
      TournamentStatus.SCHEDULED,
      TournamentStatus.IN_PROGRESS,
      TournamentStatus.COMPLETED,
      TournamentStatus.CANCELLED,
    ])('throws 422 when the tournament is %s', async (status) => {
      repository.createRegistration.mockResolvedValue({
        outcome: 'NOT_REGISTERING',
        status,
      } satisfies RegistrationOutcome);

      await expect(
        service.registerPlayer(TOURNAMENT_ID, { userId: USER_ID }),
      ).rejects.toThrow(/only open while a tournament is REGISTERING/);
    });

    it('throws 409 when the user is already registered', async () => {
      repository.createRegistration.mockResolvedValue({
        outcome: 'ALREADY_REGISTERED',
      } satisfies RegistrationOutcome);

      await expect(
        service.registerPlayer(TOURNAMENT_ID, { userId: USER_ID }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws 422 for a suspended user, before touching the database', async () => {
      users.findById.mockResolvedValue(
        userFixture({ status: UserStatus.SUSPENDED }),
      );

      await expect(
        service.registerPlayer(TOURNAMENT_ID, { userId: USER_ID }),
      ).rejects.toThrow(/suspended user cannot be registered/);

      expect(repository.createRegistration).not.toHaveBeenCalled();
    });

    it('throws 422 for a soft-deleted user', async () => {
      users.findById.mockResolvedValue(
        userFixture({ deletedAt: new Date(), status: UserStatus.DELETED }),
      );

      await expect(
        service.registerPlayer(TOURNAMENT_ID, { userId: USER_ID }),
      ).rejects.toThrow(/deleted user cannot be registered/);

      expect(repository.createRegistration).not.toHaveBeenCalled();
    });

    it('throws 404 for an unknown user', async () => {
      users.findById.mockResolvedValue(null);

      await expect(
        service.registerPlayer(TOURNAMENT_ID, { userId: USER_ID }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws 404 for an unknown tournament', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.registerPlayer(TOURNAMENT_ID, { userId: USER_ID }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('results', () => {
    beforeEach(() => {
      repository.findById.mockResolvedValue(
        tournamentFixture({
          status: TournamentStatus.IN_PROGRESS,
          _count: { registrations: 1 },
        }),
      );
      repository.findRegistrations.mockResolvedValue([registrationFixture()]);
      repository.submitResults.mockResolvedValue(
        tournamentFixture({ status: TournamentStatus.COMPLETED }),
      );
    });

    it('records placements and completes the tournament', async () => {
      await expect(
        service.submitResults(TOURNAMENT_ID, {
          results: [{ userId: USER_ID, placement: 1, prizeWon: '500.00' }],
        }),
      ).resolves.toMatchObject({ status: TournamentStatus.COMPLETED });

      const [, rows] = repository.submitResults.mock.calls[0] as [
        string,
        { userId: string; placement: number; prizeWon: Prisma.Decimal }[],
      ];

      expect(rows[0]?.prizeWon.toFixed(2)).toBe('500.00');
    });

    it.each([
      TournamentStatus.SCHEDULED,
      TournamentStatus.REGISTERING,
      TournamentStatus.COMPLETED,
      TournamentStatus.CANCELLED,
    ])('refuses to submit results for a %s tournament', async (status) => {
      repository.findById.mockResolvedValue(tournamentFixture({ status }));

      await expect(
        service.submitResults(TOURNAMENT_ID, {
          results: [{ userId: USER_ID, placement: 1 }],
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('rejects a duplicated placement', async () => {
      repository.findRegistrations.mockResolvedValue([
        registrationFixture(),
        { ...registrationFixture(), id: 'r2', userId: 'other-user' },
      ]);

      await expect(
        service.submitResults(TOURNAMENT_ID, {
          results: [
            { userId: USER_ID, placement: 1 },
            { userId: 'other-user', placement: 1 },
          ],
        }),
      ).rejects.toThrow(/placement may be awarded only once/);
    });

    it('rejects a user who is not registered', async () => {
      await expect(
        service.submitResults(TOURNAMENT_ID, {
          results: [{ userId: 'stranger', placement: 1 }],
        }),
      ).rejects.toThrow(/not registered/);
    });
  });

  describe('maxPlayers', () => {
    it('refuses to shrink capacity below the players already registered', async () => {
      repository.findById.mockResolvedValue(
        tournamentFixture({ _count: { registrations: 10 } }),
      );

      await expect(
        service.update(TOURNAMENT_ID, { maxPlayers: 8 }, undefined, ADMIN),
      ).rejects.toThrow(/cannot be lower than the 10 player/);
    });
  });

  describe('image lifecycle', () => {
    it('deletes the banner file when the tournament is deleted', async () => {
      repository.findById.mockResolvedValue(
        tournamentFixture({ imageId: 'asset-1' }),
      );
      repository.delete.mockResolvedValue(undefined);

      await service.remove(TOURNAMENT_ID);

      expect(media.deleteAsset).toHaveBeenCalledWith('asset-1');
    });

    it('removes a freshly uploaded asset when the insert fails', async () => {
      media.uploadImage.mockResolvedValue({ id: 'asset-new' });
      repository.create.mockRejectedValue(new Error('insert failed'));

      await expect(
        service.create(
          createDto(),
          { buffer: Buffer.from('x'), mimetype: 'image/png' },
          ADMIN,
        ),
      ).rejects.toThrow('insert failed');

      expect(media.deleteAsset).toHaveBeenCalledWith('asset-new');
    });

    it('replaces the banner and deletes the old file only after the update lands', async () => {
      repository.findById.mockResolvedValue(
        tournamentFixture({ imageId: 'asset-old' }),
      );
      media.uploadImage.mockResolvedValue({ id: 'asset-new' });
      repository.update.mockResolvedValue(
        tournamentFixture({ imageId: 'asset-new' }),
      );

      await service.update(
        TOURNAMENT_ID,
        {},
        { buffer: Buffer.from('x'), mimetype: 'image/png' },
        ADMIN,
      );

      const [, data] = repository.update.mock.calls[0] as [
        string,
        { imageId: string },
      ];

      expect(data.imageId).toBe('asset-new');
      expect(media.deleteAsset).toHaveBeenCalledWith('asset-old');
    });
  });
});
