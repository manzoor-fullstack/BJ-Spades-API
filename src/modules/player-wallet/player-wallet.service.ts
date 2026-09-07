import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TransactionType } from '@prisma/client';

import type { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { formatMoney } from '../../common/money/money.util';
import { TransactionsService } from '../transactions/transactions.service';
import type { TransactionItem } from '../transactions/serializers/transaction.serializer';
import { toTransactionItem } from '../transactions/serializers/transaction.serializer';
import { PlayerWalletRepository } from './repositories/player-wallet.repository';

const ZERO = new Prisma.Decimal(0);
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

@Injectable()
export class PlayerWalletService {
  constructor(
    private readonly repository: PlayerWalletRepository,
    private readonly transactions: TransactionsService,
  ) {}

  async getWallet(userId: string) {
    const totals = await this.repository.totals(
      userId,
      new Date(Date.now() - ONE_WEEK_MS),
    );
    if (!totals) throw new NotFoundException('Player not found.');

    const amount = (type: TransactionType) => totals.byType.get(type) ?? ZERO;
    const deposits = amount(TransactionType.DEPOSIT);
    const winnings = amount(TransactionType.PRIZE);
    const refunds = amount(TransactionType.REFUND);
    const entryFees = amount(TransactionType.ENTRY_FEE).abs();
    const pendingWithdrawal = totals.pendingWithdrawal.abs();

    return {
      currency: 'USD' as const,
      unit: 'TOKEN' as const,
      tokenToUsdRate: '1.00',
      availableBalance: formatMoney(totals.balance),
      pendingBalance: formatMoney(pendingWithdrawal),
      depositedAmount: formatMoney(deposits),
      lifetimeDeposits: formatMoney(deposits),
      totalWinnings: formatMoney(winnings),
      totalLosses: formatMoney(entryFees),
      tournamentEntries: formatMoney(entryFees),
      netProfit: formatMoney(winnings.plus(refunds).minus(entryFees)),
      weeklyChange: formatMoney(totals.weeklyChange),
    };
  }

  async listTransactions(userId: string, query: PaginationQueryDto) {
    const result = await this.transactions.findAll(query, { userId });
    return {
      items: result.data.map((row) => this.toPlayerTransaction(row)),
      meta: result.meta,
    };
  }

  async getTransaction(userId: string, transactionId: string) {
    const transaction = await this.repository.findOwnedTransaction(
      userId,
      transactionId,
    );
    if (!transaction) throw new NotFoundException('Transaction not found.');
    return this.toPlayerTransaction(toTransactionItem(transaction));
  }

  private toPlayerTransaction(row: TransactionItem) {
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      amount: row.amount,
      balanceAfter: row.balanceAfter,
      description: row.description,
      tournamentId: row.tournamentId,
      payoutId: row.payoutId,
      createdAt: row.createdAt,
    };
  }
}
