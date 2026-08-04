import { Module } from '@nestjs/common';

import { UsersController } from './users.controller';
import { UsersRepository } from './repositories/users.repository';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],

  providers: [UsersService, UsersRepository],

  // Exported so the registration webhook (Phase 1.7) creates users through the
  // same code path the admin panel uses instead of writing its own.
  exports: [UsersService, UsersRepository],
})
export class UsersModule {}
