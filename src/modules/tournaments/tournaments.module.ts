import { Module } from '@nestjs/common';

import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';

import { TournamentsRepository } from './repositories/tournaments.repository';
import { TournamentsController } from './tournaments.controller';
import { TournamentsService } from './tournaments.service';

@Module({
  imports: [
    // Banner uploads. Nothing here names LocalDiskStorageService — see ADR-003.
    StorageModule,
    // UsersRepository, for the suspended / soft-deleted check before a
    // registration. Reusing the repository rather than querying User directly
    // keeps the "soft-deleted rows are hidden" rule in one place.
    UsersModule,
  ],
  controllers: [TournamentsController],
  providers: [TournamentsService, TournamentsRepository],
  exports: [TournamentsService, TournamentsRepository],
})
export class TournamentsModule {}
