import { Global, Module } from '@nestjs/common';

import { TransactionsRepository } from './repositories/transactions.repository';
import { TransactionsService } from './transactions.service';

/**
 * Global because the single-writer rule only works if reaching the writer is
 * never the hard part. Users, tournaments and payouts all move money; making
 * each of them import this module is three chances to instead "just" update
 * `User.balance` and skip the ledger.
 */
@Global()
@Module({
  providers: [TransactionsService, TransactionsRepository],
  exports: [TransactionsService, TransactionsRepository],
})
export class TransactionsModule {}
