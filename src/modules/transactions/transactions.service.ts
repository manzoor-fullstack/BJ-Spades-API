import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  buildPaginationMeta,
  resolveSortField,
  SortOrder,
} from '../../common/dto/pagination.dto';
import type { PaginationQueryDto } from '../../common/dto/pagination.dto';
import type { Paginated } from '../../common/interceptors/transform.interceptor';
import { formatMoney, toMoney } from '../../common/money/money.util';

import {
  LedgerBatchError,
  TransactionsRepository,
} from './repositories/transactions.repository';
import type {
  LedgerEntryInput,
  LedgerOutcome,
  ListTransactionsArgs,
  TransactionFilter,
} from './repositories/transactions.repository';
import { toTransactionItem } from './serializers/transaction.serializer';
import type { TransactionItem } from './serializers/transaction.serializer';

const SORTABLE_FIELDS = ['createdAt', 'amount', 'type', 'status'] as const;

const DEFAULT_SORT_FIELD = 'createdAt';

/**
 * A ledger write, plus the message to use if the balance cannot absorb it.
 *
 * The message is a parameter because the caller has the context: "Insufficient
 * balance" is right for an admin adjustment, but a player being told their
 * entry fee bounced needs to hear the fee and the shortfall.
 */
export interface RecordTransactionInput extends LedgerEntryInput {
  insufficientBalanceMessage?: string;
}

export interface LedgerIntegrityIssue {
  userId: string;
  balance: string;
  ledgerTotal: string;
  /** `balance - ledgerTotal`; non-zero means something wrote the balance. */
  difference: string;
  transactionCount: number;
}

export interface LedgerIntegrityReport {
  checked: number;
  balanced: boolean;
  issues: LedgerIntegrityIssue[];
}

/**
 * The single writer of `User.balance` (docs/02-DATA-MODEL.md, "Balance
 * integrity rules").
 *
 * Nothing else in the codebase may update that column. Prisma cannot enforce
 * this at the type level, so it is held up by three things: this service being
 * the only caller of `recordLedgerEntry` outside `TournamentsRepository`
 * (which needs it inside its own transaction and imports the same function),
 * `verifyLedgerIntegrity` detecting any write that bypassed both, and review.
 */
@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(private readonly repository: TransactionsRepository) {}

  /**
   * Writes one ledger row and moves the balance, atomically.
   *
   * `amount` is signed: negative debits. A result below zero is refused with
   * 422 and nothing is written.
   */
  async record(input: RecordTransactionInput): Promise<TransactionItem> {
    const outcome = await this.repository.record(input);

    return toTransactionItem(this.unwrap(outcome, input));
  }

  /** Several rows, all-or-nothing, in one database transaction. */
  async recordMany(
    inputs: RecordTransactionInput[],
  ): Promise<TransactionItem[]> {
    if (inputs.length === 0) {
      return [];
    }

    try {
      const outcomes = await this.repository.recordMany(inputs);

      return outcomes.map((outcome, index) =>
        toTransactionItem(this.unwrap(outcome, inputs[index])),
      );
    } catch (error) {
      if (error instanceof LedgerBatchError) {
        // Re-thrown through the same mapping so a batch failure reports the
        // same 404/422 a single write would have.
        this.unwrap(error.outcome, inputs[0]);
      }

      throw error;
    }
  }

  async findAll(
    query: PaginationQueryDto,
    filter: TransactionFilter = {},
  ): Promise<Paginated<TransactionItem[]>> {
    const args: ListTransactionsArgs = {
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

    const [rows, total] = await Promise.all([
      this.repository.findMany(args),
      this.repository.count(filter),
    ]);

    return {
      data: rows.map(toTransactionItem),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  /** True when a row with this reference already exists — idempotency probe. */
  async hasReference(reference: string): Promise<boolean> {
    return (await this.repository.findByReference(reference)) !== null;
  }

  /**
   * Asserts that, for every user checked, the sum of their transaction amounts
   * equals their current balance.
   *
   * This is the whole point of recording `balanceBefore`/`balanceAfter`: the
   * ledger is auditable independently of the column it maintains. A mismatch
   * means something wrote `User.balance` outside this service — the failure
   * mode that turns into an accounting dispute months later if nothing looks
   * for it. Callable per user (cheap, after a movement) or across the whole
   * table (a maintenance job).
   */
  async verifyLedgerIntegrity(userId?: string): Promise<LedgerIntegrityReport> {
    const totals = await this.repository.ledgerTotals(userId);

    const issues = totals
      .map((total) => ({
        userId: total.userId,
        balance: total.balance,
        ledgerTotal: total.ledgerTotal,
        difference: toMoney(total.balance).minus(total.ledgerTotal),
        transactionCount: total.transactionCount,
      }))
      .filter((row) => !row.difference.isZero())
      .map((row): LedgerIntegrityIssue => ({
        userId: row.userId,
        balance: formatMoney(row.balance),
        ledgerTotal: formatMoney(row.ledgerTotal),
        difference: formatMoney(row.difference),
        transactionCount: row.transactionCount,
      }));

    if (issues.length > 0) {
      this.logger.error(
        `Ledger integrity check failed for ${issues.length} user(s): ` +
          issues
            .map((issue) => `${issue.userId} off by ${issue.difference}`)
            .join(', '),
      );
    }

    return {
      checked: totals.length,
      balanced: issues.length === 0,
      issues,
    };
  }

  /** Maps a repository outcome onto the HTTP contract. */
  private unwrap(
    outcome: LedgerOutcome,
    input: RecordTransactionInput | undefined,
  ) {
    if (outcome.outcome === 'RECORDED') {
      return outcome.transaction;
    }

    if (outcome.outcome === 'USER_NOT_FOUND') {
      throw new NotFoundException(`User ${input?.userId ?? ''} not found`);
    }

    throw new UnprocessableEntityException(
      input?.insufficientBalanceMessage ??
        `Insufficient balance: ${formatMoney(outcome.balance)} available, ` +
          `a movement of ${formatMoney(outcome.amount)} would leave ` +
          `${formatMoney(toMoney(outcome.balance).plus(outcome.amount))}.`,
    );
  }
}
