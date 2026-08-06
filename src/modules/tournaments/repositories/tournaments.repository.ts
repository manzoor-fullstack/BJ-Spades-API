import { Injectable } from '@nestjs/common';
import {
  Prisma,
  PayoutStatus,
  RegistrationStatus,
  TournamentStatus,
  TransactionType,
} from '@prisma/client';

import { toMoney } from '../../../common/money/money.util';
import type { Money } from '../../../common/money/money.util';
import { PrismaService } from '../../prisma/prisma.service';
import { recordLedgerEntry } from '../../transactions/repositories/transactions.repository';

/**
 * `_count.registrations` is selected on every read of a tournament.
 *
 * The tournaments page renders "3/16"; the mock rendered a hardcoded "0/16".
 * Fetching the count alongside the row is what makes the real numerator
 * available without a second round trip per card.
 */
const TOURNAMENT_INCLUDE = {
  image: true,
  _count: { select: { registrations: true } },
} satisfies Prisma.TournamentInclude;

export type TournamentWithRelations = Prisma.TournamentGetPayload<{
  include: typeof TOURNAMENT_INCLUDE;
}>;

/** Only the user fields the registrations drawer displays. */
const REGISTRATION_INCLUDE = {
  user: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      status: true,
      tier: true,
    },
  },
} satisfies Prisma.TournamentRegistrationInclude;

export type RegistrationWithUser = Prisma.TournamentRegistrationGetPayload<{
  include: typeof REGISTRATION_INCLUDE;
}>;

/** Expressed in domain terms; translating to Prisma is this class's job. */
export interface TournamentFilter {
  search?: string;
  status?: TournamentStatus;
}

export interface ListTournamentsArgs {
  filter: TournamentFilter;
  /** Already checked against an allowlist by the service. */
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  skip: number;
  take: number;
}

export interface CreateTournamentData {
  name: string;
  description: string | null;
  imageId: string | null;
  entryFee: Money;
  prizePool: Money;
  maxPlayers: number;
  startsAt: Date;
  status: TournamentStatus;
  createdByAdminId: string;
}

export interface UpdateTournamentData {
  name?: string;
  description?: string | null;
  imageId?: string | null;
  entryFee?: Money;
  prizePool?: Money;
  maxPlayers?: number;
  startsAt?: Date;
  status?: TournamentStatus;
  cancelledAt?: Date | null;
  cancelReason?: string | null;
}

export interface StatusCount {
  status: TournamentStatus;
  count: number;
}

export interface ResultRow {
  userId: string;
  placement: number;
  prizeWon: Money | null;
}

/**
 * Every way the transactional registration attempt can end.
 *
 * A discriminated union rather than thrown exceptions: the repository knows
 * what the database said, the service owns which HTTP status that maps to. That
 * split is what keeps `NestJS` types out of the data layer and business rules
 * out of the repository.
 */
export type RegistrationOutcome =
  | { outcome: 'CREATED'; registration: RegistrationWithUser }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'NOT_REGISTERING'; status: TournamentStatus }
  | { outcome: 'FULL'; registeredCount: number; maxPlayers: number }
  | { outcome: 'ALREADY_REGISTERED' }
  | { outcome: 'INSUFFICIENT_BALANCE'; balance: Money; entryFee: Money };

/** Shape of the locked row read back by the raw SELECT below. */
interface LockedTournamentRow {
  status: TournamentStatus;
  maxPlayers: number;
  entryFee: Money;
}

/**
 * Deterministic ledger references.
 *
 * `Transaction.reference` is `@unique`, so a reference derived from the
 * tournament and user makes a repeated write a database error rather than a
 * duplicated movement — and lets the Phase 6 backfill recognise the rows it has
 * already written. Derived from (tournamentId, userId) rather than the
 * registration id because the entry fee is debited *before* the registration
 * row exists, and because `@@unique([tournamentId, userId])` makes the pair
 * just as unique.
 */
export function entryFeeReference(
  tournamentId: string,
  userId: string,
): string {
  return `entry_fee:${tournamentId}:${userId}`;
}

export function refundReference(tournamentId: string, userId: string): string {
  return `refund:${tournamentId}:${userId}`;
}

@Injectable()
export class TournamentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private buildWhere(filter: TournamentFilter): Prisma.TournamentWhereInput {
    const where: Prisma.TournamentWhereInput = {};

    if (filter.status) {
      where.status = filter.status;
    }

    if (filter.search) {
      where.name = { contains: filter.search, mode: 'insensitive' };
    }

    return where;
  }

  findMany(args: ListTournamentsArgs): Promise<TournamentWithRelations[]> {
    return this.prisma.tournament.findMany({
      where: this.buildWhere(args.filter),
      include: TOURNAMENT_INCLUDE,
      // The id tiebreak keeps paging stable when the sort column has ties;
      // without it page 2 can repeat a row from page 1.
      orderBy: [{ [args.sortBy]: args.sortOrder }, { id: 'asc' }],
      skip: args.skip,
      take: args.take,
    });
  }

  count(filter: TournamentFilter): Promise<number> {
    return this.prisma.tournament.count({ where: this.buildWhere(filter) });
  }

  findById(id: string): Promise<TournamentWithRelations | null> {
    return this.prisma.tournament.findUnique({
      where: { id },
      include: TOURNAMENT_INCLUDE,
    });
  }

  create(data: CreateTournamentData): Promise<TournamentWithRelations> {
    return this.prisma.tournament.create({
      data,
      include: TOURNAMENT_INCLUDE,
    });
  }

  update(
    id: string,
    data: UpdateTournamentData,
  ): Promise<TournamentWithRelations> {
    return this.prisma.tournament.update({
      where: { id },
      data,
      include: TOURNAMENT_INCLUDE,
    });
  }

  async delete(id: string): Promise<void> {
    // Registrations cascade (onDelete: Cascade on the relation); the MediaAsset
    // does not, because assets are shared-by-design and are cleaned up by the
    // caller through MediaService.
    await this.prisma.tournament.delete({ where: { id } });
  }

  async countByStatus(): Promise<StatusCount[]> {
    const rows = await this.prisma.tournament.groupBy({
      by: ['status'],
      _count: { _all: true },
    });

    return rows.map((row) => ({ status: row.status, count: row._count._all }));
  }

  /** Cancelled tournaments are excluded: their prize money is not on offer. */
  async sumPrizePool(): Promise<Money | null> {
    const result = await this.prisma.tournament.aggregate({
      where: { status: { not: TournamentStatus.CANCELLED } },
      _sum: { prizePool: true },
    });

    return result._sum.prizePool;
  }

  countAll(): Promise<number> {
    return this.prisma.tournament.count();
  }

  countAllRegistrations(): Promise<number> {
    return this.prisma.tournamentRegistration.count({
      where: { tournament: { status: { not: TournamentStatus.CANCELLED } } },
    });
  }

  findRegistrations(
    tournamentId: string,
    skip: number,
    take: number,
  ): Promise<RegistrationWithUser[]> {
    return this.prisma.tournamentRegistration.findMany({
      where: { tournamentId },
      include: REGISTRATION_INCLUDE,
      orderBy: [
        { placement: { sort: 'asc', nulls: 'last' } },
        { registeredAt: 'asc' },
      ],
      skip,
      take,
    });
  }

  countRegistrations(tournamentId: string): Promise<number> {
    return this.prisma.tournamentRegistration.count({
      where: { tournamentId },
    });
  }

  findRegistration(
    tournamentId: string,
    userId: string,
  ): Promise<RegistrationWithUser | null> {
    return this.prisma.tournamentRegistration.findUnique({
      where: { tournamentId_userId: { tournamentId, userId } },
      include: REGISTRATION_INCLUDE,
    });
  }

  /**
   * Registers a player, re-checking status and capacity inside the transaction.
   *
   * The `SELECT … FOR UPDATE` is the important line. Without it two requests for
   * the final slot both read `registeredCount = maxPlayers - 1`, both pass the
   * check, and the tournament ends up over capacity — the unique constraint
   * cannot help, because the two registrations are for *different* users. The
   * row lock makes the second request wait for the first to commit and then
   * count again, so exactly one of them wins.
   *
   * A duplicate registration is still ultimately decided by
   * `@@unique([tournamentId, userId])`: the lookup below is a friendlier error
   * message, not the guarantee.
   *
   * Phase 6 added the entry-fee debit, and it happens *before* the registration
   * row is created rather than after. Debiting afterwards would need the
   * registration deleting again when the balance turns out to be short; doing
   * it first means the short-balance path simply returns having written
   * nothing. Both live in this one transaction, so a registration with no fee —
   * or a fee with no registration — is not a state the database can reach.
   */
  createRegistration(
    tournamentId: string,
    userId: string,
  ): Promise<RegistrationOutcome> {
    return this.prisma.$transaction(async (tx) => {
      // No `::uuid` cast: Prisma maps `String @id @default(uuid())` to a TEXT
      // column, and casting the parameter would fail with
      // "operator does not exist: text = uuid".
      const locked = await tx.$queryRaw<LockedTournamentRow[]>`
        SELECT "status", "maxPlayers", "entryFee"
        FROM "Tournament"
        WHERE "id" = ${tournamentId}
        FOR UPDATE
      `;

      const tournament = locked[0];

      if (!tournament) {
        return { outcome: 'NOT_FOUND' };
      }

      if (tournament.status !== TournamentStatus.REGISTERING) {
        return { outcome: 'NOT_REGISTERING', status: tournament.status };
      }

      const registeredCount = await tx.tournamentRegistration.count({
        where: { tournamentId },
      });

      if (registeredCount >= tournament.maxPlayers) {
        return {
          outcome: 'FULL',
          registeredCount,
          maxPlayers: tournament.maxPlayers,
        };
      }

      const existing = await tx.tournamentRegistration.findUnique({
        where: { tournamentId_userId: { tournamentId, userId } },
        select: { id: true },
      });

      if (existing) {
        return { outcome: 'ALREADY_REGISTERED' };
      }

      const entryFee = toMoney(tournament.entryFee);

      if (entryFee.greaterThan(0)) {
        const ledger = await recordLedgerEntry(tx, {
          userId,
          type: TransactionType.ENTRY_FEE,
          // Signed: a fee is a debit.
          amount: entryFee.negated(),
          description: 'Tournament entry fee',
          reference: entryFeeReference(tournamentId, userId),
          tournamentId,
        });

        if (ledger.outcome === 'INSUFFICIENT_BALANCE') {
          return {
            outcome: 'INSUFFICIENT_BALANCE',
            balance: ledger.balance,
            entryFee,
          };
        }

        if (ledger.outcome === 'USER_NOT_FOUND') {
          return { outcome: 'NOT_FOUND' };
        }
      }

      const registration = await tx.tournamentRegistration.create({
        data: {
          tournamentId,
          userId,
          status: RegistrationStatus.REGISTERED,
        },
        include: REGISTRATION_INCLUDE,
      });

      return { outcome: 'CREATED', registration };
    });
  }

  async deleteRegistration(
    tournamentId: string,
    userId: string,
  ): Promise<void> {
    await this.prisma.tournamentRegistration.delete({
      where: { tournamentId_userId: { tournamentId, userId } },
    });
  }

  /**
   * Writes every placement, creates a payout for every prize, and flips the
   * tournament to COMPLETED — atomically.
   *
   * One transaction because a half-applied result set is worse than none: a
   * COMPLETED tournament missing its winner, placements recorded against a
   * tournament still shown as in progress, or — since Phase 6 — a prize
   * recorded on a registration with no payout row behind it.
   *
   * Deliberately no balance movement here. Submitting results creates the
   * *obligation* (a PENDING payout); the money moves in
   * `POST /payouts/:id/process`, once an admin has approved it and Stripe has
   * accepted the transfer. Crediting at this point would pay every winner
   * automatically the moment a bracket was typed in.
   */
  async submitResults(
    tournamentId: string,
    results: ResultRow[],
  ): Promise<TournamentWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      for (const result of results) {
        const prize = result.prizeWon ? toMoney(result.prizeWon) : null;

        // A placement without a prize (everyone below the paid places) gets a
        // recorded result and no payout — there is nothing owed.
        const payout =
          prize && prize.greaterThan(0)
            ? await tx.payout.create({
                data: {
                  userId: result.userId,
                  amount: prize,
                  tournamentId,
                  placement: result.placement,
                  status: PayoutStatus.PENDING,
                  owedSince: new Date(),
                },
              })
            : null;

        await tx.tournamentRegistration.update({
          where: {
            tournamentId_userId: { tournamentId, userId: result.userId },
          },
          data: {
            placement: result.placement,
            prizeWon: result.prizeWon,
            ...(payout ? { payoutId: payout.id } : {}),
          },
        });
      }

      return tx.tournament.update({
        where: { id: tournamentId },
        data: { status: TournamentStatus.COMPLETED },
        include: TOURNAMENT_INCLUDE,
      });
    });
  }

  /**
   * Cancels a tournament and refunds every entry fee it collected, atomically.
   *
   * Refunds are matched to the ENTRY_FEE rows actually written, not to the
   * tournament's current `entryFee`: the fee may have been edited since, and
   * what has to come back is what was taken. A player who already has a REFUND
   * row is skipped, so a re-run cannot pay them twice — the unique reference
   * makes that a database guarantee rather than a code convention.
   *
   * One transaction because half the players refunded is worse than none:
   * nobody, including the operator, can tell which half.
   */
  async cancelWithRefunds(
    tournamentId: string,
    data: UpdateTournamentData,
  ): Promise<TournamentWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      const fees = await tx.transaction.findMany({
        where: { tournamentId, type: TransactionType.ENTRY_FEE },
        select: { userId: true, amount: true },
      });

      for (const fee of fees) {
        const reference = refundReference(tournamentId, fee.userId);

        const alreadyRefunded = await tx.transaction.findUnique({
          where: { reference },
          select: { id: true },
        });

        if (alreadyRefunded) {
          continue;
        }

        const outcome = await recordLedgerEntry(tx, {
          userId: fee.userId,
          type: TransactionType.REFUND,
          // The fee was stored signed-negative; negating it credits it back.
          amount: toMoney(fee.amount).negated(),
          description: 'Entry fee refunded — tournament cancelled',
          reference,
          tournamentId,
        });

        if (outcome.outcome !== 'RECORDED') {
          // A refund is a credit, so the only way here is a vanished user.
          // Aborting is right: a partial refund set is unauditable.
          throw new Error(
            `Failed to refund the entry fee for user ${fee.userId}: ${outcome.outcome}`,
          );
        }
      }

      return tx.tournament.update({
        where: { id: tournamentId },
        data,
        include: TOURNAMENT_INCLUDE,
      });
    });
  }
}
