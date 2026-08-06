import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ActivityCategory } from '@prisma/client';

import { ACTIVITY_ACTIONS } from '../../common/constants/activity-actions';
import { PERMISSION_CODES } from '../../common/constants/permissions';
import {
  AuditLog,
  readString,
  type AuditContext,
} from '../../common/decorators/audit-log.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../auth/interfaces/authenticated-admin.interface';
import { ImageUploadInterceptor } from '../storage/image-upload.interceptor';
import type { ValidatableUpload } from '../storage/image-validation';

import { CancelTournamentDto } from './dto/cancel-tournament.dto';
import { CreateTournamentDto } from './dto/create-tournament.dto';
import { QueryTournamentsDto } from './dto/query-tournaments.dto';
import { RegisterPlayerDto } from './dto/register-player.dto';
import { SubmitResultsDto } from './dto/submit-results.dto';
import { UpdateTournamentDto } from './dto/update-tournament.dto';
import { TournamentsService } from './tournaments.service';

/** The audited subject, however much of it the handler gave back. */
function tournamentLabel(ctx: AuditContext, result: unknown): string {
  return readString(result, 'name') ?? ctx.params.id ?? 'tournament';
}

function tournamentId(ctx: AuditContext, result: unknown): string | undefined {
  return (
    readString(result, 'tournamentId') ??
    readString(result, 'id') ??
    ctx.params.id
  );
}

/**
 * Route order is significant. `stats` is declared before `:id` because Nest
 * matches in declaration order — declared after, `GET /tournaments/stats` would
 * be served by `findOne('stats')` and fail the UUID pipe.
 */
@ApiTags('tournaments')
@ApiBearerAuth('access-token')
@Controller('tournaments')
export class TournamentsController {
  constructor(private readonly tournamentsService: TournamentsService) {}

  @RequirePermissions(PERMISSION_CODES.TOURNAMENTS_MANAGE)
  @Get()
  @ApiOperation({
    summary:
      'List tournaments with pagination, status filter, name search and sorting',
  })
  findAll(@Query() query: QueryTournamentsDto) {
    return this.tournamentsService.findAll(query);
  }

  @RequirePermissions(PERMISSION_CODES.TOURNAMENTS_MANAGE)
  @Get('stats')
  @ApiOperation({ summary: 'Aggregate counts powering the tournament cards' })
  stats() {
    return this.tournamentsService.stats();
  }

  @RequirePermissions(PERMISSION_CODES.TOURNAMENTS_MANAGE)
  @Get(':id')
  @ApiOperation({ summary: 'Fetch one tournament' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.tournamentsService.findOne(id);
  }

  @RequirePermissions(PERMISSION_CODES.TOURNAMENTS_MANAGE)
  @AuditLog({
    category: ActivityCategory.TOURNAMENT,
    action: ACTIVITY_ACTIONS.TOURNAMENT_CREATED.code,
    title: (ctx, result) =>
      `Tournament ${tournamentLabel(ctx, result)} created`,
    entityType: 'Tournament',
    entityId: tournamentId,
  })
  @Post()
  @UseInterceptors(ImageUploadInterceptor('image'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: CreateTournamentDto })
  @ApiOperation({
    summary:
      'Create a tournament. multipart/form-data with an optional `image`; startDate + startTime are combined into a UTC startsAt.',
  })
  create(
    @Body() createTournamentDto: CreateTournamentDto,
    @UploadedFile() image: ValidatableUpload | undefined,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.tournamentsService.create(createTournamentDto, image, admin);
  }

  @RequirePermissions(PERMISSION_CODES.TOURNAMENTS_MANAGE)
  @AuditLog({
    category: ActivityCategory.TOURNAMENT,
    action: ACTIVITY_ACTIONS.TOURNAMENT_UPDATED.code,
    title: (ctx, result) =>
      `Tournament ${tournamentLabel(ctx, result)} updated`,
    entityType: 'Tournament',
    entityId: tournamentId,
    // What was asked for, not a before/after: the pre-update row lives inside
    // TournamentsService and never reaches the interceptor.
    metadata: (ctx) => ({ submitted: ctx.body }),
  })
  @Patch(':id')
  @UseInterceptors(ImageUploadInterceptor('image'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UpdateTournamentDto })
  @ApiOperation({
    summary:
      'Update a tournament. Supplying an `image` replaces the banner and deletes the old file.',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateTournamentDto: UpdateTournamentDto,
    @UploadedFile() image: ValidatableUpload | undefined,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.tournamentsService.update(
      id,
      updateTournamentDto,
      image,
      admin,
    );
  }

  @RequirePermissions(PERMISSION_CODES.TOURNAMENTS_MANAGE)
  @AuditLog({
    category: ActivityCategory.TOURNAMENT,
    action: ACTIVITY_ACTIONS.TOURNAMENT_CANCELLED.code,
    title: (ctx, result) =>
      `Tournament ${tournamentLabel(ctx, result)} cancelled`,
    description: (ctx) => readString(ctx.body, 'reason'),
    entityType: 'Tournament',
    entityId: tournamentId,
    metadata: (ctx, result) => ({
      reason: readString(ctx.body, 'reason'),
      cancelledAt: readString(result, 'cancelledAt'),
    }),
  })
  @Patch(':id/cancel')
  @ApiOperation({ summary: 'Cancel a tournament; a reason is required' })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() cancelTournamentDto: CancelTournamentDto,
  ) {
    return this.tournamentsService.cancel(id, cancelTournamentDto);
  }

  @RequirePermissions(PERMISSION_CODES.TOURNAMENTS_MANAGE)
  @AuditLog({
    category: ActivityCategory.TOURNAMENT,
    action: ACTIVITY_ACTIONS.TOURNAMENT_DELETED.code,
    title: (ctx, result) =>
      `Tournament ${tournamentLabel(ctx, result)} deleted`,
    entityType: 'Tournament',
    entityId: (ctx) => ctx.params.id,
  })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a tournament, its registrations and its banner file',
  })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.tournamentsService.remove(id);
  }

  @RequirePermissions(PERMISSION_CODES.TOURNAMENTS_MANAGE)
  @Get(':id/registrations')
  @ApiOperation({ summary: 'Registered players, paginated, with user summary' })
  findRegistrations(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.tournamentsService.findRegistrations(id, query);
  }

  @RequirePermissions(PERMISSION_CODES.TOURNAMENTS_MANAGE)
  @AuditLog({
    category: ActivityCategory.TOURNAMENT,
    action: ACTIVITY_ACTIONS.TOURNAMENT_PLAYER_REGISTERED.code,
    title: (ctx, result) =>
      `Player ${readString(result, 'userId') ?? readString(ctx.body, 'userId') ?? 'unknown'} registered for tournament ${ctx.params.id}`,
    entityType: 'Tournament',
    entityId: (ctx) => ctx.params.id,
    metadata: (_ctx, result) => ({ userId: readString(result, 'userId') }),
  })
  @Post(':id/registrations')
  @ApiOperation({ summary: 'Register a user for a tournament' })
  registerPlayer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() registerPlayerDto: RegisterPlayerDto,
  ) {
    return this.tournamentsService.registerPlayer(id, registerPlayerDto);
  }

  @RequirePermissions(PERMISSION_CODES.TOURNAMENTS_MANAGE)
  @AuditLog({
    category: ActivityCategory.TOURNAMENT,
    action: ACTIVITY_ACTIONS.TOURNAMENT_PLAYER_REMOVED.code,
    title: (ctx) =>
      `Player ${ctx.params.userId} removed from tournament ${ctx.params.id}`,
    entityType: 'Tournament',
    entityId: (ctx) => ctx.params.id,
    metadata: (ctx) => ({ userId: ctx.params.userId }),
  })
  @Delete(':id/registrations/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a registered player' })
  removePlayer(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.tournamentsService.removePlayer(id, userId);
  }

  @RequirePermissions(PERMISSION_CODES.TOURNAMENTS_MANAGE)
  @AuditLog({
    category: ActivityCategory.TOURNAMENT,
    action: ACTIVITY_ACTIONS.TOURNAMENT_RESULTS_SUBMITTED.code,
    title: (ctx, result) =>
      `Results submitted for tournament ${tournamentLabel(ctx, result)}`,
    entityType: 'Tournament',
    entityId: tournamentId,
    metadata: (ctx) => ({ submitted: ctx.body }),
  })
  @Post(':id/results')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Record final placements and prize amounts, and complete the tournament. No money moves until Phase 6.',
  })
  submitResults(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() submitResultsDto: SubmitResultsDto,
  ) {
    return this.tournamentsService.submitResults(id, submitResultsDto);
  }
}
