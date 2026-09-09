import { Module } from '@nestjs/common';

import { StorageModule } from '../storage/storage.module';
import { PlayerAuthModule } from '../player-auth/player-auth.module';
import { UsersModule } from '../users/users.module';

import { TournamentsRepository } from './repositories/tournaments.repository';
import { TournamentsController } from './tournaments.controller';
import { TournamentsService } from './tournaments.service';
import { PlayerTournamentsController } from './player-tournaments.controller';
import { PlayerTournamentsService } from './player-tournaments.service';
import { TournamentProgressionService } from './tournament-progression.service';

@Module({
  imports: [
    // Banner uploads. Nothing here names LocalDiskStorageService — see ADR-003.
    StorageModule,
    PlayerAuthModule,
    // UsersRepository, for the suspended / soft-deleted check before a
    // registration. Reusing the repository rather than querying User directly
    // keeps the "soft-deleted rows are hidden" rule in one place.
    UsersModule,
  ],
  controllers: [TournamentsController, PlayerTournamentsController],
  providers: [
    TournamentsService,
    TournamentsRepository,
    PlayerTournamentsService,
    TournamentProgressionService,
  ],
  exports: [
    TournamentsService,
    TournamentsRepository,
    TournamentProgressionService,
  ],
})
export class TournamentsModule {}
