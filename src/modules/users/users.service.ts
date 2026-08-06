import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  TransactionType,
  UserSource,
  UserStatus,
  UserTier,
} from '@prisma/client';
import type { User } from '@prisma/client';

import { toCsvRow } from '../../common/csv/csv.util';
import {
  buildPaginationMeta,
  resolveSortField,
  SortOrder,
} from '../../common/dto/pagination.dto';
import type { Paginated } from '../../common/interceptors/transform.interceptor';
import { formatMoney, toMoney } from '../../common/money/money.util';
import { splitFullName } from '../../common/text/split-full-name.util';
import type { AuthenticatedAdmin } from '../auth/interfaces/authenticated-admin.interface';
import { TransactionsService } from '../transactions/transactions.service';

import { AdjustBalanceDto } from './dto/adjust-balance.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersRepository } from './repositories/users.repository';
import type {
  CreateUserData,
  GroupCount,
  ListUsersArgs,
  UpdateUserData,
  UserFilter,
} from './repositories/users.repository';
import { toUserDetail, toUserListItem } from './serializers/user.serializer';
import type {
  BalanceAdjustment,
  UserBalance,
  UserDetail,
  UserListItem,
} from './serializers/user.serializer';

/**
 * Columns a client may sort by. Anything else falls back to `createdAt` —
 * `sortBy` reaches Prisma as an object key, so an unfiltered value is both an
 * injection surface and a way to order by columns we never meant to expose.
 */
const SORTABLE_FIELDS = [
  'createdAt',
  'updatedAt',
  'firstName',
  'lastName',
  'email',
  'balance',
  'status',
  'tier',
  'lastActiveAt',
] as const;

const DEFAULT_SORT_FIELD = 'createdAt';

/** Rows fetched per round trip while streaming the CSV export. */
const EXPORT_BATCH_SIZE = 500;

/**
 * Hard ceiling on an export. Unbounded, a single request could pull the whole
 * user table into an HTTP response and hold the connection open for minutes.
 */
const EXPORT_MAX_ROWS = 50_000;

const CSV_COLUMNS = [
  'id',
  'firstName',
  'lastName',
  'fullName',
  'email',
  'phone',
  'status',
  'tier',
  'source',
  'balance',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'postalCode',
  'country',
  'emailVerified',
  'lastActiveAt',
  'createdAt',
] as const;

export interface UserStats {
  total: number;
  active: number;
  suspended: number;
  pending: number;
  newThisMonth: number;
  bySource: Record<UserSource, number>;
  byTier: Record<UserTier, number>;
}

function countOf(groups: GroupCount[], key: string): number {
  return groups.find((group) => group.key === key)?.count ?? 0;
}

/**
 * A bare `2026-08-04` parses to midnight, which would exclude everything
 * created during that day — the opposite of what "createdTo: today" means to
 * the person who typed it. A value carrying an explicit time is left alone.
 */
function parseRangeEnd(value: string): Date {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);

  return new Date(dateOnly ? `${value}T23:59:59.999Z` : value);
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalisePhone(phone: string | undefined): string | null {
  const trimmed = phone?.trim();

  return trimmed ? trimmed : null;
}

function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

function toCsvValues(user: User): (string | number | boolean | Date | null)[] {
  const item = toUserListItem(user);

  return [
    item.id,
    item.firstName,
    item.lastName,
    item.fullName,
    item.email,
    item.phone,
    item.status,
    item.tier,
    item.source,
    item.balance,
    user.addressLine1,
    user.addressLine2,
    user.city,
    user.state,
    user.postalCode,
    user.country,
    user.emailVerified,
    item.lastActiveAt,
    item.createdAt,
  ];
}

@Injectable()
export class UsersService {
  constructor(
    private readonly repository: UsersRepository,
    // The single writer of `User.balance`. UsersService no longer touches the
    // column: `applyBalanceDelta` was removed from UsersRepository so there is
    // no second way in.
    private readonly transactions: TransactionsService,
  ) {}

  async findAll(query: QueryUsersDto): Promise<Paginated<UserListItem[]>> {
    const args = this.buildListArgs(query);

    const [users, total] = await Promise.all([
      this.repository.findMany(args),
      this.repository.count(args.filter),
    ]);

    return {
      data: users.map(toUserListItem),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async findOne(id: string): Promise<UserDetail> {
    return toUserDetail(await this.getOrThrow(id));
  }

  async create(
    dto: CreateUserDto,
    admin: AuthenticatedAdmin,
  ): Promise<UserDetail> {
    const email = normaliseEmail(dto.email);
    const phone = normalisePhone(dto.mobileNumber);

    await this.assertEmailAvailable(email);
    await this.assertPhoneAvailable(phone);

    const { firstName, lastName } = splitFullName(dto.fullName);

    const data: CreateUserData = {
      firstName,
      lastName,
      email,
      phone,
      status: UserStatus.ACTIVE,
      tier: dto.tier ?? UserTier.PLAYER,
      source: UserSource.ADMIN,
      // Phase 6 replaces this with an opening ADJUSTMENT transaction and
      // backfills the rows created before it existed (docs/phases/PHASE-1.md).
      balance: toMoney(dto.initialBalance ?? 0),
      addressLine1: emptyToNull(dto.addressLine1),
      addressLine2: emptyToNull(dto.addressLine2),
      city: emptyToNull(dto.city),
      state: emptyToNull(dto.state),
      postalCode: emptyToNull(dto.postalCode),
      country: emptyToNull(dto.country),
      createdByAdminId: admin.id,
    };

    return toUserDetail(await this.repository.create(data));
  }

  async update(id: string, dto: UpdateUserDto): Promise<UserDetail> {
    const existing = await this.getOrThrow(id);

    const data: UpdateUserData = {};

    if (dto.fullName !== undefined) {
      const { firstName, lastName } = splitFullName(dto.fullName);
      data.firstName = firstName;
      data.lastName = lastName;
    }

    if (dto.email !== undefined) {
      const email = normaliseEmail(dto.email);

      if (email !== existing.email) {
        await this.assertEmailAvailable(email);
        data.email = email;
      }
    }

    if (dto.mobileNumber !== undefined) {
      const phone = normalisePhone(dto.mobileNumber);

      if (phone !== existing.phone) {
        await this.assertPhoneAvailable(phone, id);
        data.phone = phone;
      }
    }

    if (dto.tier !== undefined) {
      data.tier = dto.tier;
    }

    if (dto.addressLine1 !== undefined) {
      data.addressLine1 = emptyToNull(dto.addressLine1);
    }

    if (dto.addressLine2 !== undefined) {
      data.addressLine2 = emptyToNull(dto.addressLine2);
    }

    if (dto.city !== undefined) {
      data.city = emptyToNull(dto.city);
    }

    if (dto.state !== undefined) {
      data.state = emptyToNull(dto.state);
    }

    if (dto.postalCode !== undefined) {
      data.postalCode = emptyToNull(dto.postalCode);
    }

    if (dto.country !== undefined) {
      data.country = emptyToNull(dto.country);
    }

    return toUserDetail(await this.repository.update(id, data));
  }

  /**
   * The reason is mandated by the contract and will be written to the
   * ActivityLog once Phase 2 introduces that table. Until then it is validated
   * and accepted, so no caller has to change when the log arrives.
   */
  async suspend(
    id: string,
    _reason: string,
    _admin: AuthenticatedAdmin,
  ): Promise<UserDetail> {
    const user = await this.getOrThrow(id);
    this.assertNotDeleted(user, 'suspend');

    return toUserDetail(
      await this.repository.update(id, {
        status: UserStatus.SUSPENDED,
        lastActiveAt: new Date(),
      }),
    );
  }

  async activate(id: string, _admin: AuthenticatedAdmin): Promise<UserDetail> {
    const user = await this.getOrThrow(id);
    this.assertNotDeleted(user, 'activate');

    return toUserDetail(
      await this.repository.update(id, {
        status: UserStatus.ACTIVE,
        lastActiveAt: new Date(),
      }),
    );
  }

  /**
   * Soft delete. Hard-deleting a user referenced by transactions and tournament
   * registrations would destroy financial history, so the row stays and both
   * fields move: `deletedAt` drives the default list filter, `status` keeps the
   * enum honest for anything reading the column directly.
   */
  /**
   * Returns the deleted user even though the route answers 204.
   *
   * Nest discards the body for a 204, but the value still travels through the
   * interceptor chain — which is what lets AuditInterceptor name the person in
   * the audit title instead of logging a bare UUID.
   */
  async remove(id: string): Promise<UserDetail> {
    await this.getOrThrow(id);

    return toUserDetail(
      await this.repository.update(id, {
        status: UserStatus.DELETED,
        deletedAt: new Date(),
      }),
    );
  }

  async getBalance(id: string): Promise<UserBalance> {
    const user = await this.getOrThrow(id);

    return { userId: user.id, balance: formatMoney(user.balance) };
  }

  /**
   * Credits or debits a balance, through the ledger.
   *
   * Phase 6 moved the write itself into `TransactionsService`, which is the
   * only thing in the codebase permitted to touch `User.balance`
   * (docs/02-DATA-MODEL.md, "Balance integrity rules"). The response shape and
   * both error messages are unchanged; what changed is that the adjustment now
   * leaves an `ADJUSTMENT` row behind it, so the integrity check can see it.
   *
   * The pre-check below is kept even though the ledger repeats it inside the
   * UPDATE: it is what produces the specific "X available, Y would leave Z"
   * message, and it means the common case never reaches the database. The
   * ledger's own guard is what closes the race between the two.
   */
  async adjustBalance(
    id: string,
    dto: AdjustBalanceDto,
    admin: AuthenticatedAdmin,
  ): Promise<BalanceAdjustment> {
    const user = await this.getOrThrow(id);
    this.assertNotDeleted(user, 'adjust the balance of');

    const amount = toMoney(dto.amount);
    const previous = toMoney(user.balance);
    const next = previous.plus(amount);

    if (next.isNegative()) {
      throw new UnprocessableEntityException(
        `Insufficient balance: ${formatMoney(previous)} available, an adjustment of ` +
          `${formatMoney(amount)} would leave ${formatMoney(next)}.`,
      );
    }

    const entry = await this.transactions.record({
      userId: id,
      type: TransactionType.ADJUSTMENT,
      amount,
      description: dto.reason,
      createdByAdminId: admin.id,
      // Reached only when a concurrent movement consumed the balance between
      // the check above and the guarded UPDATE inside the ledger.
      insufficientBalanceMessage:
        'The balance changed while this adjustment was being applied. Retry it.',
    });

    return {
      userId: id,
      previousBalance: entry.balanceBefore,
      amount: entry.amount,
      balance: entry.balanceAfter,
      reason: dto.reason,
    };
  }

  async stats(): Promise<UserStats> {
    const now = new Date();
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );

    const [byStatus, bySource, byTier, newThisMonth] = await Promise.all([
      this.repository.countByStatus(),
      this.repository.countBySource(),
      this.repository.countByTier(),
      this.repository.countCreatedSince(monthStart),
    ]);

    return {
      // Summed from the status groups, which already exclude soft-deleted rows.
      total: byStatus.reduce((sum, group) => sum + group.count, 0),
      active: countOf(byStatus, UserStatus.ACTIVE),
      suspended: countOf(byStatus, UserStatus.SUSPENDED),
      pending: countOf(byStatus, UserStatus.PENDING),
      newThisMonth,
      bySource: {
        [UserSource.ADMIN]: countOf(bySource, UserSource.ADMIN),
        [UserSource.WEBHOOK]: countOf(bySource, UserSource.WEBHOOK),
      },
      byTier: {
        [UserTier.PLAYER]: countOf(byTier, UserTier.PLAYER),
        [UserTier.PREMIUM]: countOf(byTier, UserTier.PREMIUM),
        [UserTier.VIP]: countOf(byTier, UserTier.VIP),
      },
    };
  }

  /**
   * Yields the export a batch at a time so a large result set never sits in
   * memory in full. `page` and `limit` are ignored on purpose: an export covers
   * everything the filters match, not one page of it.
   */
  async *streamCsv(query: QueryUsersDto): AsyncGenerator<string> {
    const { filter, sortBy, sortOrder } = this.buildListArgs(query);

    yield `${toCsvRow([...CSV_COLUMNS])}\n`;

    let skip = 0;

    while (skip < EXPORT_MAX_ROWS) {
      const take = Math.min(EXPORT_BATCH_SIZE, EXPORT_MAX_ROWS - skip);

      const users = await this.repository.findMany({
        filter,
        sortBy,
        sortOrder,
        skip,
        take,
      });

      if (users.length === 0) {
        return;
      }

      yield `${users.map((user) => toCsvRow(toCsvValues(user))).join('\n')}\n`;

      if (users.length < take) {
        return;
      }

      skip += users.length;
    }
  }

  exportFilename(now: Date = new Date()): string {
    return `users-export-${now.toISOString().slice(0, 10)}.csv`;
  }

  private buildListArgs(query: QueryUsersDto): ListUsersArgs {
    const filter: UserFilter = {
      search: query.search?.trim() ? query.search.trim() : undefined,
      status: query.status,
      tier: query.tier,
      source: query.source,
      createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
      createdTo: query.createdTo ? parseRangeEnd(query.createdTo) : undefined,
      includeDeleted: query.status === UserStatus.DELETED,
    };

    return {
      filter,
      sortBy: resolveSortField(
        query.sortBy,
        SORTABLE_FIELDS,
        DEFAULT_SORT_FIELD,
      ),
      sortOrder: query.sortOrder === SortOrder.ASC ? 'asc' : 'desc',
      skip: query.skip,
      take: query.take,
    };
  }

  private async getOrThrow(id: string): Promise<User> {
    const user = await this.repository.findById(id);

    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }

    return user;
  }

  private assertNotDeleted(user: User, action: string): void {
    if (user.deletedAt) {
      throw new UnprocessableEntityException(
        `Cannot ${action} a deleted user.`,
      );
    }
  }

  private async assertEmailAvailable(email: string): Promise<void> {
    if (await this.repository.findByEmail(email)) {
      throw new ConflictException('A user with this email already exists');
    }
  }

  private async assertPhoneAvailable(
    phone: string | null,
    excludeId?: string,
  ): Promise<void> {
    if (!phone) {
      return;
    }

    const existing = await this.repository.findByPhone(phone);

    if (existing && existing.id !== excludeId) {
      throw new ConflictException(
        'A user with this phone number already exists',
      );
    }
  }
}
