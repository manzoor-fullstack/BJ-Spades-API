import { NotFoundException } from '@nestjs/common';
import { Prisma, TransactionStatus, TransactionType } from '@prisma/client';

import { PlayerWalletService } from '../player-wallet.service';

const transaction = {
  id: 'tx-1',
  userId: 'player-1',
  type: TransactionType.PRIZE,
  status: TransactionStatus.COMPLETED,
  amount: '40.00',
  balanceBefore: '70.50',
  balanceAfter: '110.50',
  description: 'First place',
  reference: 'prize:1',
  tournamentId: 'tournament-1',
  payoutId: null,
  createdByAdminId: 'admin-1',
  createdAt: new Date('2026-09-07T10:00:00.000Z'),
};

describe('PlayerWalletService', () => {
  const repository = {
    totals: jest.fn(),
    findOwnedTransaction: jest.fn(),
  };
  const transactions = { findAll: jest.fn() };
  const service = new PlayerWalletService(
    repository as never,
    transactions as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it('calculates the 1 token to 1 USD wallet from completed ledger totals', async () => {
    repository.totals.mockResolvedValue({
      balance: new Prisma.Decimal('110.50'),
      byType: new Map([
        [TransactionType.DEPOSIT, new Prisma.Decimal('100.50')],
        [TransactionType.PRIZE, new Prisma.Decimal('40.00')],
        [TransactionType.ENTRY_FEE, new Prisma.Decimal('-25.25')],
        [TransactionType.REFUND, new Prisma.Decimal('5.25')],
      ]),
      weeklyChange: new Prisma.Decimal('120.50'),
      pendingWithdrawal: new Prisma.Decimal('-10.00'),
    });

    await expect(service.getWallet('player-1')).resolves.toEqual({
      currency: 'USD',
      unit: 'TOKEN',
      tokenToUsdRate: '1.00',
      availableBalance: '110.50',
      pendingBalance: '10.00',
      depositedAmount: '100.50',
      lifetimeDeposits: '100.50',
      totalWinnings: '40.00',
      totalLosses: '25.25',
      tournamentEntries: '25.25',
      netProfit: '20.00',
      weeklyChange: '120.50',
    });
  });

  it('always scopes transaction pages to the authenticated player', async () => {
    transactions.findAll.mockResolvedValue({
      data: [transaction],
      meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
    });
    const query = {
      page: 1,
      limit: 20,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    };

    const result = await service.listTransactions('player-1', query as never);

    expect(transactions.findAll).toHaveBeenCalledWith(query, {
      userId: 'player-1',
    });
    expect(result.items[0]).toEqual({
      id: 'tx-1',
      type: TransactionType.PRIZE,
      status: TransactionStatus.COMPLETED,
      amount: '40.00',
      balanceAfter: '110.50',
      description: 'First place',
      tournamentId: 'tournament-1',
      payoutId: null,
      createdAt: transaction.createdAt,
    });
    expect(result.items[0]).not.toHaveProperty('userId');
    expect(result.items[0]).not.toHaveProperty('createdByAdminId');
    expect(result.items[0]).not.toHaveProperty('reference');
  });

  it('does not reveal a transaction outside the authenticated player', async () => {
    repository.findOwnedTransaction.mockResolvedValue(null);
    await expect(
      service.getTransaction('player-1', 'somebody-elses-transaction'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
