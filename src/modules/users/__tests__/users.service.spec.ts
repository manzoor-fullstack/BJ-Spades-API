import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  StripeAccountStatus,
  UserSource,
  UserStatus,
  UserTier,
} from '@prisma/client';
import type { User } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { toMoney } from '../../../common/money/money.util';
import type { Money } from '../../../common/money/money.util';
import type { AuthenticatedAdmin } from '../../auth/interfaces/authenticated-admin.interface';
import { AdjustBalanceDto } from '../dto/adjust-balance.dto';
import { CreateUserDto } from '../dto/create-user.dto';
import { QueryUsersDto } from '../dto/query-users.dto';
import { UpdateUserDto } from '../dto/update-user.dto';
import type {
  CreateUserData,
  ListUsersArgs,
  UpdateUserData,
  UserFilter,
} from '../repositories/users.repository';
import { UsersRepository } from '../repositories/users.repository';
import { UsersService } from '../users.service';
import type { TransactionsService } from '../../transactions/transactions.service';
import type { TransactionItem } from '../../transactions/serializers/transaction.serializer';

type MockedRepository = { [K in keyof UsersRepository]: jest.Mock };
type MockedTransactions = { [K in keyof TransactionsService]: jest.Mock };

/**
 * Typed view of what a mock was called with.
 *
 * `jest.Mock.mock.calls` is `any[][]`, and this suite asserts on the exact
 * arguments the service hands the repository — reading them as `any` would let
 * a renamed field pass silently.
 */
function callsOf<T extends unknown[]>(mock: { mock: { calls: T[] } }): T[] {
  return mock.mock.calls;
}

const ADMIN: AuthenticatedAdmin = {
  id: 'admin-1',
  email: 'admin@bjspades.com',
  role: 'SUPER_ADMIN',
  roleId: 'role-1',
  sessionId: 'session-1',
};

const BASE_USER: User = {
  id: 'user-1',
  firstName: 'John',
  lastName: 'Mitchell',
  email: 'john.mitchell@email.com',
  phone: '+15555551234',
  addressLine1: '123 Main St',
  addressLine2: null,
  city: 'New York',
  state: 'NY',
  postalCode: '10001',
  country: 'United States',
  balance: toMoney('100.00'),
  status: UserStatus.ACTIVE,
  tier: UserTier.VIP,
  source: UserSource.ADMIN,
  emailVerified: false,
  emailVerifiedAt: null,
  lastActiveAt: null,
  createdByAdminId: ADMIN.id,
  webhookEventId: null,
  // Added by the Phase 6 schema; a Prisma `User` now includes these.
  stripeConnectAccountId: null,
  stripeAccountStatus: StripeAccountStatus.NOT_CONNECTED,
  stripeVerifiedAt: null,
  deletedAt: null,
  createdAt: new Date('2026-06-01T10:00:00.000Z'),
  updatedAt: new Date('2026-06-01T10:00:00.000Z'),
};

function makeUser(overrides: Partial<User> = {}): User {
  return { ...BASE_USER, ...overrides };
}

/** What UsersService hands the ledger. */
interface LedgerCall {
  userId: string;
  type: string;
  amount: unknown;
  description?: string;
  createdByAdminId?: string;
  insufficientBalanceMessage?: string;
}

function ledgerRow(
  input: LedgerCall,
  before: Money,
  amount: Money,
  after: Money,
): TransactionItem {
  return {
    id: 'transaction-1',
    userId: input.userId,
    type: 'ADJUSTMENT',
    status: 'COMPLETED',
    amount: amount.toFixed(2),
    balanceBefore: before.toFixed(2),
    balanceAfter: after.toFixed(2),
    description: input.description ?? null,
    reference: null,
    tournamentId: null,
    payoutId: null,
    createdByAdminId: input.createdByAdminId ?? null,
    createdAt: new Date('2026-08-06T00:00:00.000Z'),
  };
}

/** Builds a QueryUsersDto the way the ValidationPipe would, defaults included. */
function query(raw: Record<string, unknown> = {}): QueryUsersDto {
  return plainToInstance(QueryUsersDto, raw, {
    enableImplicitConversion: true,
  });
}

function createDto(overrides: Partial<CreateUserDto> = {}): CreateUserDto {
  return plainToInstance(CreateUserDto, {
    fullName: 'John Mitchell',
    email: 'john.mitchell@email.com',
    ...overrides,
  });
}

describe('UsersService', () => {
  let service: UsersService;
  let repository: MockedRepository;
  let transactions: MockedTransactions;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findById: jest.fn().mockResolvedValue(makeUser()),
      findByEmail: jest.fn().mockResolvedValue(null),
      findByPhone: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((data: CreateUserData) =>
          Promise.resolve(makeUser(data)),
        ),
      update: jest
        .fn()
        .mockImplementation((id: string, data: UpdateUserData) =>
          Promise.resolve(makeUser({ id, ...data })),
        ),
      countByStatus: jest.fn().mockResolvedValue([]),
      countBySource: jest.fn().mockResolvedValue([]),
      countByTier: jest.fn().mockResolvedValue([]),
      countCreatedSince: jest.fn().mockResolvedValue(0),
    };

    // Phase 6: the balance is no longer written by UsersRepository. The fake
    // stands in for the ledger and reproduces its arithmetic — including the
    // below-zero refusal — so the assertions below still describe what the
    // endpoint does, not how it is plumbed.
    transactions = {
      record: jest.fn().mockImplementation(async (input: LedgerCall) => {
        const user = (await repository.findById(input.userId)) as User | null;
        const before = toMoney(user?.balance ?? 0);
        const amount = toMoney(input.amount as string | number);
        const after = before.plus(amount);

        if (after.isNegative()) {
          throw new UnprocessableEntityException(
            input.insufficientBalanceMessage ?? 'Insufficient balance',
          );
        }

        return ledgerRow(input, before, amount, after);
      }),
      recordMany: jest.fn().mockResolvedValue([]),
      findAll: jest.fn(),
      hasReference: jest.fn().mockResolvedValue(false),
      verifyLedgerIntegrity: jest
        .fn()
        .mockResolvedValue({ checked: 0, balanced: true, issues: [] }),
    };

    service = new UsersService(
      repository as unknown as UsersRepository,
      transactions as unknown as TransactionsService,
    );
  });

  /** The filter the service actually handed the repository. */
  const recordedFilter = (): UserFilter | undefined =>
    callsOf<[ListUsersArgs]>(repository.findMany)[0]?.[0].filter;

  describe('create — fullName splitting', () => {
    const cases: [string, string, string][] = [
      ['John Mitchell', 'John', 'Mitchell'],
      ['Mary Jane Watson', 'Mary', 'Jane Watson'],
      ['Cher', 'Cher', ''],
      ['  Padded   Name  ', 'Padded', 'Name'],
      ['Ana  Maria  De  Souza', 'Ana', 'Maria De Souza'],
      ['van Gogh', 'van', 'Gogh'],
    ];

    it.each(cases)(
      '%s splits into "%s" / "%s"',
      async (fullName, firstName, lastName) => {
        await service.create(createDto({ fullName }), ADMIN);

        expect(repository.create).toHaveBeenCalledWith(
          expect.objectContaining({ firstName, lastName }),
        );
      },
    );

    it('computes fullName and initials back from the split columns', async () => {
      const result = await service.create(
        createDto({ fullName: 'Mary Jane Watson' }),
        ADMIN,
      );

      expect(result.fullName).toBe('Mary Jane Watson');
      expect(result.initials).toBe('MJ');
    });

    it('tolerates a single-word name when building initials', async () => {
      const result = await service.create(
        createDto({ fullName: 'Cher' }),
        ADMIN,
      );

      expect(result.fullName).toBe('Cher');
      expect(result.initials).toBe('C');
    });
  });

  describe('create — defaults and audit trail', () => {
    it('forces source=ADMIN, status=ACTIVE and stamps the creating admin', async () => {
      await service.create(createDto(), ADMIN);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          source: UserSource.ADMIN,
          status: UserStatus.ACTIVE,
          tier: UserTier.PLAYER,
          createdByAdminId: ADMIN.id,
        }),
      );
    });

    it('lowercases and trims the email', async () => {
      await service.create(
        createDto({ email: '  John.Mitchell@Email.COM ' }),
        ADMIN,
      );

      expect(repository.findByEmail).toHaveBeenCalledWith(
        'john.mitchell@email.com',
      );
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'john.mitchell@email.com' }),
      );
    });

    it('stores a missing mobileNumber as null rather than an empty string', async () => {
      await service.create(createDto({ mobileNumber: undefined }), ADMIN);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ phone: null }),
      );
    });

    it('serialises the opening balance as a two-decimal string', async () => {
      repository.create.mockResolvedValue(makeUser({ balance: toMoney(100) }));

      const result = await service.create(
        createDto({ initialBalance: 100 }),
        ADMIN,
      );

      expect(result.balance).toBe('100.00');
    });

    it('defaults the balance to zero when no initialBalance is given', async () => {
      await service.create(createDto(), ADMIN);

      const data = callsOf<[CreateUserData]>(repository.create)[0]?.[0];

      expect(data?.balance.toFixed(2)).toBe('0.00');
    });
  });

  describe('create — conflicts', () => {
    it('rejects a duplicate email with 409', async () => {
      repository.findByEmail.mockResolvedValue(makeUser());

      await expect(service.create(createDto(), ADMIN)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('rejects a duplicate phone with 409', async () => {
      repository.findByPhone.mockResolvedValue(makeUser({ id: 'other' }));

      await expect(
        service.create(createDto({ mobileNumber: '+15555551234' }), ADMIN),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  describe('CreateUserDto validation', () => {
    const errorsFor = (raw: Record<string, unknown>) =>
      validate(plainToInstance(CreateUserDto, raw));

    it('rejects a negative initialBalance', async () => {
      const errors = await errorsFor({
        fullName: 'John Mitchell',
        email: 'john@email.com',
        initialBalance: -1,
      });

      expect(errors.map((error) => error.property)).toContain('initialBalance');
      expect(JSON.stringify(errors)).toContain('min');
    });

    it('accepts an initialBalance of exactly zero', async () => {
      const errors = await errorsFor({
        fullName: 'John Mitchell',
        email: 'john@email.com',
        initialBalance: 0,
      });

      expect(errors).toHaveLength(0);
    });

    it('rejects an initialBalance with more than two decimal places', async () => {
      const errors = await errorsFor({
        fullName: 'John Mitchell',
        email: 'john@email.com',
        initialBalance: 1.234,
      });

      expect(errors.map((error) => error.property)).toContain('initialBalance');
    });

    it('rejects a fullName shorter than two characters', async () => {
      const errors = await errorsFor({ fullName: 'J', email: 'j@email.com' });

      expect(errors.map((error) => error.property)).toContain('fullName');
    });

    it('rejects a fullName that is only whitespace', async () => {
      const errors = await errorsFor({ fullName: '   ', email: 'j@email.com' });

      expect(errors.map((error) => error.property)).toContain('fullName');
    });

    it('rejects a fullName longer than 100 characters', async () => {
      const errors = await errorsFor({
        fullName: 'a'.repeat(101),
        email: 'j@email.com',
      });

      expect(errors.map((error) => error.property)).toContain('fullName');
    });

    it('rejects a malformed email', async () => {
      const errors = await errorsFor({ fullName: 'John M', email: 'nope' });

      expect(errors.map((error) => error.property)).toContain('email');
    });
  });

  describe('UpdateUserDto', () => {
    it('has no property for source, balance or status — those have their own endpoints', () => {
      const dto = plainToInstance(UpdateUserDto, {
        source: 'WEBHOOK',
        balance: 999,
        status: 'ACTIVE',
        initialBalance: 5,
      }) as unknown as Record<string, unknown>;

      // The global pipe runs with forbidNonWhitelisted, so these arrive as
      // "property should not exist" 400s rather than silent no-ops.
      expect(Object.keys(new UpdateUserDto())).not.toContain('status');
      expect(dto.tier).toBeUndefined();
    });
  });

  describe('findAll — filter composition', () => {
    it('passes every filter through together', async () => {
      await service.findAll(
        query({
          search: '  mitch  ',
          status: UserStatus.SUSPENDED,
          tier: UserTier.VIP,
          source: UserSource.WEBHOOK,
          createdFrom: '2026-01-01',
          createdTo: '2026-12-31',
        }),
      );

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: {
            search: 'mitch',
            status: UserStatus.SUSPENDED,
            tier: UserTier.VIP,
            source: UserSource.WEBHOOK,
            createdFrom: new Date('2026-01-01'),
            createdTo: new Date('2026-12-31T23:59:59.999Z'),
            includeDeleted: false,
          },
        }),
      );
    });

    it('hides soft-deleted users by default', async () => {
      await service.findAll(query());

      expect(recordedFilter()?.includeDeleted).toBe(false);
    });

    it('includes soft-deleted users only when status=DELETED is explicit', async () => {
      await service.findAll(query({ status: UserStatus.DELETED }));

      expect(recordedFilter()?.status).toBe(UserStatus.DELETED);
      expect(recordedFilter()?.includeDeleted).toBe(true);
    });

    it('drops a blank search term instead of matching on an empty string', async () => {
      await service.findAll(query({ search: '   ' }));

      expect(recordedFilter()?.search).toBeUndefined();
    });

    it('counts with exactly the same filter it lists with', async () => {
      await service.findAll(query({ status: UserStatus.PENDING }));

      expect(repository.count).toHaveBeenCalledWith(recordedFilter());
    });

    it('builds meta from the total, page and limit', async () => {
      repository.count.mockResolvedValue(147);
      repository.findMany.mockResolvedValue([makeUser()]);

      const result = await service.findAll(query({ page: 2, limit: 20 }));

      expect(result.meta).toEqual({
        page: 2,
        limit: 20,
        total: 147,
        totalPages: 8,
      });
    });

    it('translates page/limit into skip/take', async () => {
      await service.findAll(query({ page: 3, limit: 10 }));

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
    });
  });

  describe('findAll — sortBy allowlist', () => {
    it.each(['createdAt', 'email', 'balance', 'lastName', 'status'])(
      'passes the allowlisted field %s straight through',
      async (sortBy) => {
        await service.findAll(query({ sortBy }));

        expect(repository.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ sortBy }),
        );
      },
    );

    it.each([
      'password',
      'id; DROP TABLE "User"',
      'createdByAdmin.email',
      '__proto__',
    ])('falls back to createdAt for the rejected field %s', async (sortBy) => {
      await service.findAll(query({ sortBy }));

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ sortBy: 'createdAt' }),
      );
    });

    it('normalises sortOrder to asc/desc', async () => {
      await service.findAll(query({ sortOrder: 'asc' }));
      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ sortOrder: 'asc' }),
      );

      await service.findAll(query({}));
      expect(repository.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ sortOrder: 'desc' }),
      );
    });
  });

  describe('QueryUsersDto — limit bounds', () => {
    const errorsFor = (raw: Record<string, unknown>) =>
      validate(
        plainToInstance(QueryUsersDto, raw, { enableImplicitConversion: true }),
      );

    it('rejects limit=500 rather than silently clamping it', async () => {
      const errors = await errorsFor({ limit: 500 });

      expect(errors.map((error) => error.property)).toContain('limit');
      expect(JSON.stringify(errors)).toContain('max');
    });

    it('accepts the maximum limit of 100', async () => {
      expect(await errorsFor({ limit: 100 })).toHaveLength(0);
    });

    it.each([0, -1])('rejects limit=%s', async (limit) => {
      const errors = await errorsFor({ limit });

      expect(errors.map((error) => error.property)).toContain('limit');
    });

    it('rejects page=0', async () => {
      const errors = await errorsFor({ page: 0 });

      expect(errors.map((error) => error.property)).toContain('page');
    });

    it('rejects an unknown status value', async () => {
      const errors = await errorsFor({ status: 'BANNED' });

      expect(errors.map((error) => error.property)).toContain('status');
    });

    it('defaults to page 1, limit 20, createdAt desc', () => {
      const dto = plainToInstance(QueryUsersDto, {});

      expect(dto.page).toBe(1);
      expect(dto.limit).toBe(20);
      expect(dto.sortBy).toBe('createdAt');
      expect(dto.sortOrder).toBe('desc');
      expect(dto.skip).toBe(0);
      expect(dto.take).toBe(20);
    });
  });

  describe('findOne', () => {
    it('throws 404 for an unknown id', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.findOne('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('serialises balance as a string and adds fullName/initials', async () => {
      repository.findById.mockResolvedValue(
        makeUser({ balance: toMoney('12450.5') }),
      );

      const result = await service.findOne('user-1');

      expect(result.balance).toBe('12450.50');
      expect(result.fullName).toBe('John Mitchell');
      expect(result.initials).toBe('JM');
    });
  });

  describe('update', () => {
    it('re-splits fullName into both columns', async () => {
      await service.update('user-1', { fullName: 'Sarah Jane Chen' });

      expect(repository.update).toHaveBeenCalledWith('user-1', {
        firstName: 'Sarah',
        lastName: 'Jane Chen',
      });
    });

    it('does not check for a conflict when the email is unchanged', async () => {
      await service.update('user-1', { email: 'John.Mitchell@email.com' });

      expect(repository.findByEmail).not.toHaveBeenCalled();
    });

    it('rejects an email already taken by someone else', async () => {
      repository.findByEmail.mockResolvedValue(makeUser({ id: 'other' }));

      await expect(
        service.update('user-1', { email: 'taken@email.com' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('allows a phone that is only held by the user being updated', async () => {
      repository.findByPhone.mockResolvedValue(makeUser({ id: 'user-1' }));

      await expect(
        service.update('user-1', { mobileNumber: '+15550009999' }),
      ).resolves.toBeDefined();
    });

    it('throws 404 for an unknown id', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.update('missing', {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('suspend and activate', () => {
    it('suspend sets status=SUSPENDED', async () => {
      await service.suspend('user-1', 'Suspected fraud', ADMIN);

      expect(repository.update).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ status: UserStatus.SUSPENDED }),
      );
    });

    it('activate sets status=ACTIVE', async () => {
      repository.findById.mockResolvedValue(
        makeUser({ status: UserStatus.SUSPENDED }),
      );

      await service.activate('user-1', ADMIN);

      expect(repository.update).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ status: UserStatus.ACTIVE }),
      );
    });

    it('refuses to resurrect a deleted user through activate', async () => {
      repository.findById.mockResolvedValue(
        makeUser({ status: UserStatus.DELETED, deletedAt: new Date() }),
      );

      await expect(service.activate('user-1', ADMIN)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('throws 404 for an unknown id', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.suspend('missing', 'because', ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove — soft delete', () => {
    it('sets deletedAt AND status=DELETED, and never hard-deletes', async () => {
      await service.remove('user-1');

      const call = callsOf<[string, UpdateUserData]>(repository.update)[0];

      expect(call?.[0]).toBe('user-1');
      expect(call?.[1].status).toBe(UserStatus.DELETED);
      expect(call?.[1].deletedAt).toBeInstanceOf(Date);
    });

    it('throws 404 for an unknown id', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.remove('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('balance', () => {
    const adjust = (amount: number, reason = 'Chargeback #1234') =>
      plainToInstance(AdjustBalanceDto, { amount, reason });

    it('returns the current balance as a two-decimal string', async () => {
      repository.findById.mockResolvedValue(makeUser({ balance: toMoney(0) }));

      await expect(service.getBalance('user-1')).resolves.toEqual({
        userId: 'user-1',
        balance: '0.00',
      });
    });

    it('credits a positive amount', async () => {
      repository.findById.mockResolvedValue(
        makeUser({ balance: toMoney('100.00') }),
      );

      const result = await service.adjustBalance(
        'user-1',
        adjust(50.25),
        ADMIN,
      );

      expect(result).toEqual({
        userId: 'user-1',
        previousBalance: '100.00',
        amount: '50.25',
        balance: '150.25',
        reason: 'Chargeback #1234',
      });
    });

    it('debits a negative amount', async () => {
      repository.findById.mockResolvedValue(
        makeUser({ balance: toMoney('100.00') }),
      );

      const result = await service.adjustBalance('user-1', adjust(-40), ADMIN);

      expect(result.balance).toBe('60.00');
      expect(result.amount).toBe('-40.00');
    });

    it('rejects a debit that would go below zero with 422', async () => {
      repository.findById.mockResolvedValue(
        makeUser({ balance: toMoney('100.00') }),
      );

      await expect(
        service.adjustBalance('user-1', adjust(-100.01), ADMIN),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);

      // Refused before the ledger is touched, so nothing is written and the
      // caller gets the specific "X available, Y would leave Z" message.
      expect(transactions.record).not.toHaveBeenCalled();
    });

    it('allows a debit that lands exactly on zero', async () => {
      repository.findById.mockResolvedValue(
        makeUser({ balance: toMoney('100.00') }),
      );

      const result = await service.adjustBalance('user-1', adjust(-100), ADMIN);

      expect(result.balance).toBe('0.00');
    });

    it('writes the adjustment through the ledger, signed and attributed', async () => {
      repository.findById.mockResolvedValue(
        makeUser({ balance: toMoney('100.00') }),
      );

      await service.adjustBalance('user-1', adjust(-40), ADMIN);

      const call = callsOf<[LedgerCall]>(transactions.record)[0]?.[0];

      expect(call?.userId).toBe('user-1');
      expect(call?.type).toBe('ADJUSTMENT');
      expect(toMoney(call?.amount as number).toFixed(2)).toBe('-40.00');
      expect(call?.createdByAdminId).toBe(ADMIN.id);
      // The reason is mandatory on the DTO and is what the ledger row says.
      expect(call?.description).toBe('Chargeback #1234');
    });

    it('never writes User.balance itself — the ledger is the only writer', () => {
      // The property is gone from the repository entirely; if it comes back,
      // this fails to compile rather than failing at runtime.
      expect('applyBalanceDelta' in repository).toBe(false);
    });

    it('reports 422 when a concurrent change made the guarded update a no-op', async () => {
      repository.findById.mockResolvedValue(
        makeUser({ balance: toMoney('100.00') }),
      );
      transactions.record.mockRejectedValue(
        new UnprocessableEntityException(
          'The balance changed while this adjustment was being applied. Retry it.',
        ),
      );

      await expect(
        service.adjustBalance('user-1', adjust(-10), ADMIN),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('refuses to move money on a deleted user', async () => {
      repository.findById.mockResolvedValue(
        makeUser({ deletedAt: new Date(), status: UserStatus.DELETED }),
      );

      await expect(
        service.adjustBalance('user-1', adjust(10), ADMIN),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('adds no float error across a run of adjustments', async () => {
      let balance = toMoney('0.00');

      repository.findById.mockImplementation(() =>
        Promise.resolve(makeUser({ balance })),
      );
      transactions.record.mockImplementation((input: LedgerCall) => {
        const before = balance;
        const amount = toMoney(input.amount as number);

        balance = before.plus(amount);

        return Promise.resolve(ledgerRow(input, before, amount, balance));
      });

      for (let i = 0; i < 10; i += 1) {
        await service.adjustBalance('user-1', adjust(0.1), ADMIN);
      }

      // 0.1 added ten times is exactly 1.00 through Decimal; as a float it is
      // 0.9999999999999999, which is the accounting discrepancy nobody can
      // reconcile six months later.
      expect(balance.toFixed(2)).toBe('1.00');
    });

    it('throws 404 for an unknown id', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.adjustBalance('missing', adjust(10), ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('AdjustBalanceDto validation', () => {
    const errorsFor = (raw: Record<string, unknown>) =>
      validate(plainToInstance(AdjustBalanceDto, raw));

    it('requires a reason of at least three characters', async () => {
      const errors = await errorsFor({ amount: -10, reason: 'no' });

      expect(errors.map((error) => error.property)).toContain('reason');
    });

    it('requires an amount', async () => {
      const errors = await errorsFor({ reason: 'Chargeback' });

      expect(errors.map((error) => error.property)).toContain('amount');
    });

    it('accepts a negative amount', async () => {
      expect(
        await errorsFor({
          amount: -500,
          reason: 'Chargeback on deposit #1234',
        }),
      ).toHaveLength(0);
    });

    it('rejects more than two decimal places', async () => {
      const errors = await errorsFor({ amount: 1.005, reason: 'Rounding' });

      expect(errors.map((error) => error.property)).toContain('amount');
    });
  });

  describe('stats', () => {
    it('assembles the dashboard figures from the group counts', async () => {
      repository.countByStatus.mockResolvedValue([
        { key: UserStatus.ACTIVE, count: 2610 },
        { key: UserStatus.SUSPENDED, count: 37 },
        { key: UserStatus.PENDING, count: 12 },
        { key: UserStatus.INACTIVE, count: 188 },
      ]);
      repository.countBySource.mockResolvedValue([
        { key: UserSource.ADMIN, count: 340 },
        { key: UserSource.WEBHOOK, count: 2507 },
      ]);
      repository.countByTier.mockResolvedValue([
        { key: UserTier.PLAYER, count: 2100 },
        { key: UserTier.PREMIUM, count: 600 },
        { key: UserTier.VIP, count: 147 },
      ]);
      repository.countCreatedSince.mockResolvedValue(124);

      await expect(service.stats()).resolves.toEqual({
        total: 2847,
        active: 2610,
        suspended: 37,
        pending: 12,
        newThisMonth: 124,
        bySource: { ADMIN: 340, WEBHOOK: 2507 },
        byTier: { PLAYER: 2100, PREMIUM: 600, VIP: 147 },
      });
    });

    it('reports zero for a status, source or tier with no rows', async () => {
      await expect(service.stats()).resolves.toEqual({
        total: 0,
        active: 0,
        suspended: 0,
        pending: 0,
        newThisMonth: 0,
        bySource: { ADMIN: 0, WEBHOOK: 0 },
        byTier: { PLAYER: 0, PREMIUM: 0, VIP: 0 },
      });
    });

    it('counts new users from the first of the current UTC month', async () => {
      await service.stats();

      const since = callsOf<[Date]>(repository.countCreatedSince)[0]?.[0];
      const now = new Date();

      expect(since?.getUTCDate()).toBe(1);
      expect(since?.getUTCMonth()).toBe(now.getUTCMonth());
      expect(since?.getUTCFullYear()).toBe(now.getUTCFullYear());
      expect(since?.getUTCHours()).toBe(0);
    });
  });

  describe('streamCsv', () => {
    const collect = async (generator: AsyncGenerator<string>) => {
      let out = '';
      for await (const chunk of generator) out += chunk;
      return out;
    };

    it('emits a header row even when nothing matches', async () => {
      const csv = await collect(service.streamCsv(query()));

      expect(csv.trim().split('\n')).toHaveLength(1);
      expect(csv).toContain('"id","firstName","lastName","fullName","email"');
    });

    it('quotes every cell and escapes embedded quotes', async () => {
      repository.findMany.mockResolvedValue([
        makeUser({ firstName: 'Jo"hn', lastName: 'O,Brien' }),
      ]);

      const csv = await collect(service.streamCsv(query()));

      expect(csv).toContain('"Jo""hn"');
      expect(csv).toContain('"O,Brien"');
    });

    it('applies exactly the filters GET /users would apply', async () => {
      await collect(
        service.streamCsv(
          query({ status: UserStatus.SUSPENDED, search: 'kim' }),
        ),
      );

      expect(recordedFilter()?.status).toBe(UserStatus.SUSPENDED);
      expect(recordedFilter()?.search).toBe('kim');
    });

    it('ignores page and limit — an export is not one page', async () => {
      await collect(service.streamCsv(query({ page: 5, limit: 1 })));

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 500 }),
      );
    });

    it('keeps paging while full batches come back', async () => {
      const fullBatch = Array.from({ length: 500 }, (_, index) =>
        makeUser({ id: `user-${index}` }),
      );

      repository.findMany
        .mockResolvedValueOnce(fullBatch)
        .mockResolvedValueOnce([makeUser({ id: 'last' })]);

      const csv = await collect(service.streamCsv(query()));

      expect(repository.findMany).toHaveBeenCalledTimes(2);
      expect(repository.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ skip: 500 }),
      );
      expect(csv.trim().split('\n')).toHaveLength(502);
    });

    it('names the download after the export date', () => {
      expect(service.exportFilename(new Date('2026-08-04T09:00:00Z'))).toBe(
        'users-export-2026-08-04.csv',
      );
    });
  });
});
