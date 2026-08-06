import { PrismaPg } from '@prisma/adapter-pg';
import {
  Prisma,
  PrismaClient,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import * as dotenv from 'dotenv';

/**
 * Reconciles the ledger with the two phases that ran before it existed
 * (docs/phases/PHASE-6.md, 6.5 and 6.6).
 *
 *  - Phase 1.5 wrote `initialBalance` straight to `User.balance`.
 *  - Phase 4 recorded entry fees on registrations without debiting anybody.
 *
 * Both left `User.balance` correct and the ledger empty, so
 * `verifyLedgerIntegrity` fails for every affected user until this has run.
 *
 * ## What it writes, and why the arithmetic works
 *
 * Per user, in chronological order:
 *
 *  1. one opening `ADJUSTMENT` dated to `user.createdAt`, with
 *     `balanceBefore: 0`;
 *  2. one `ENTRY_FEE` per registration whose tournament charged a fee, dated to
 *     `registration.registeredAt`.
 *
 * The opening amount is **not** the current balance — it is
 * `balance + Σ fees`. That is the only value which makes the chain end where
 * the column already sits: start at the opening figure, subtract each fee, and
 * the running total lands exactly on `User.balance`. Setting the opening entry
 * to the current balance instead would leave every user short by their fees and
 * the integrity check failing, which is the trap this comment exists to
 * document.
 *
 * **No balance is modified.** The money moved before the ledger existed; this
 * script records what happened, it does not re-enact it. It is the one place in
 * the codebase that writes `Transaction` rows without going through
 * `recordLedgerEntry`, precisely because it must not move a balance.
 *
 * ## Idempotency
 *
 * Every row carries a deterministic `reference`, and `Transaction.reference` is
 * `@unique`. A user who already has ledger rows is skipped outright, and each
 * fee is checked by reference — the references match the ones
 * `TournamentsRepository` writes for live registrations, so a tournament joined
 * after Phase 6 is never double-counted. Re-running is a no-op.
 */

export function openingReference(userId: string): string {
  return `backfill:opening:${userId}`;
}

/**
 * Must match `entryFeeReference` in
 * `src/modules/tournaments/repositories/tournaments.repository.ts` exactly —
 * that is what stops the backfill duplicating a live entry fee.
 */
export function entryFeeReference(
  tournamentId: string,
  userId: string,
): string {
  return `entry_fee:${tournamentId}:${userId}`;
}

export interface BackfillSummary {
  usersExamined: number;
  openingAdjustments: number;
  entryFees: number;
  skippedUsersWithLedger: number;
}

interface PendingFee {
  tournamentId: string;
  amount: Prisma.Decimal;
  reference: string;
  registeredAt: Date;
  tournamentName: string;
}

export async function backfillTransactions(
  prisma: PrismaClient,
): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    usersExamined: 0,
    openingAdjustments: 0,
    entryFees: 0,
    skippedUsersWithLedger: 0,
  };

  const users = await prisma.user.findMany({
    select: { id: true, balance: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  for (const user of users) {
    summary.usersExamined += 1;

    // A user with any ledger row has been through Phase 6 already. Adding an
    // opening entry now would double-count whatever those rows represent.
    const existingRows = await prisma.transaction.count({
      where: { userId: user.id },
    });

    if (existingRows > 0) {
      summary.skippedUsersWithLedger += 1;
      continue;
    }

    const registrations = await prisma.tournamentRegistration.findMany({
      where: { userId: user.id, tournament: { entryFee: { gt: 0 } } },
      select: {
        registeredAt: true,
        tournament: { select: { id: true, name: true, entryFee: true } },
      },
      orderBy: { registeredAt: 'asc' },
    });

    const fees: PendingFee[] = registrations.map((registration) => ({
      tournamentId: registration.tournament.id,
      amount: registration.tournament.entryFee,
      reference: entryFeeReference(registration.tournament.id, user.id),
      registeredAt: registration.registeredAt,
      tournamentName: registration.tournament.name,
    }));

    const totalFees = fees.reduce(
      (sum, fee) => sum.plus(fee.amount),
      new Prisma.Decimal(0),
    );

    const opening = new Prisma.Decimal(user.balance).plus(totalFees);

    // Nothing to reconcile: no balance was ever set and no fee was ever
    // charged, so an empty ledger already sums to the balance.
    if (opening.isZero() && fees.length === 0) {
      continue;
    }

    await prisma.$transaction(async (tx) => {
      let running = new Prisma.Decimal(0);

      if (!opening.isZero()) {
        await tx.transaction.create({
          data: {
            userId: user.id,
            type: TransactionType.ADJUSTMENT,
            status: TransactionStatus.COMPLETED,
            amount: opening,
            balanceBefore: running,
            balanceAfter: opening,
            description:
              'Opening balance — reconciled when the ledger was introduced (Phase 6)',
            reference: openingReference(user.id),
            createdAt: user.createdAt,
          },
        });

        running = opening;
        summary.openingAdjustments += 1;
      }

      for (const fee of fees) {
        const before = running;
        const after = before.minus(fee.amount);

        await tx.transaction.create({
          data: {
            userId: user.id,
            type: TransactionType.ENTRY_FEE,
            status: TransactionStatus.COMPLETED,
            amount: fee.amount.negated(),
            balanceBefore: before,
            balanceAfter: after,
            description: `Tournament entry fee — ${fee.tournamentName}`,
            reference: fee.reference,
            tournamentId: fee.tournamentId,
            createdAt: fee.registeredAt,
          },
        });

        running = after;
        summary.entryFees += 1;
      }
    });
  }

  return summary;
}

/**
 * Re-implements the integrity check without importing the Nest service, so the
 * script can be run against a database with nothing else loaded.
 */
export async function reportIntegrity(prisma: PrismaClient): Promise<number> {
  const [users, groups] = await Promise.all([
    prisma.user.findMany({ select: { id: true, balance: true } }),
    prisma.transaction.groupBy({ by: ['userId'], _sum: { amount: true } }),
  ]);

  const byUser = new Map(groups.map((group) => [group.userId, group]));

  const drifted = users.filter((user) => {
    const total = new Prisma.Decimal(byUser.get(user.id)?._sum.amount ?? 0);

    return !new Prisma.Decimal(user.balance).minus(total).isZero();
  });

  for (const user of drifted) {
    const total = new Prisma.Decimal(byUser.get(user.id)?._sum.amount ?? 0);

    console.error(
      `  ✗ ${user.id}: balance ${user.balance.toFixed(2)}, ledger ${total.toFixed(2)}`,
    );
  }

  return drifted.length;
}

async function main(): Promise<void> {
  // Loaded here, not at import time. The integration suite imports
  // `backfillTransactions` from this module and has already pointed
  // DATABASE_URL at the test database — a top-level `dotenv/config` would run
  // during that import and risk pulling `.env` in behind it.
  dotenv.config();

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
  });

  const prisma = new PrismaClient({ adapter });

  try {
    console.log('🧾 Backfilling the transaction ledger...');

    const summary = await backfillTransactions(prisma);

    console.log(`   users examined:       ${summary.usersExamined}`);
    console.log(`   opening adjustments:  ${summary.openingAdjustments}`);
    console.log(`   entry fees:           ${summary.entryFees}`);
    console.log(`   already reconciled:   ${summary.skippedUsersWithLedger}`);

    const drifted = await reportIntegrity(prisma);

    if (drifted > 0) {
      // Exiting non-zero matters: a silent partial reconciliation is exactly
      // the state this script exists to prevent.
      throw new Error(
        `Ledger integrity check failed for ${drifted} user(s) after the backfill.`,
      );
    }

    console.log('✅ Ledger integrity check passed for every user');
  } finally {
    await prisma.$disconnect();
  }
}

// Only when executed directly. Imported by the integration suite, which drives
// `backfillTransactions` against the test database itself.
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
