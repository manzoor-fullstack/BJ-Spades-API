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
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ActivityCategory } from '@prisma/client';
import type { Response } from 'express';

import { computeDiff } from '../../common/audit/compute-diff.util';
import { ACTIVITY_ACTIONS } from '../../common/constants/activity-actions';
import { PERMISSION_CODES } from '../../common/constants/permissions';
import {
  AuditLog,
  readString,
  type AuditContext,
} from '../../common/decorators/audit-log.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../auth/interfaces/authenticated-admin.interface';

import { AdjustBalanceDto } from './dto/adjust-balance.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';
import { SuspendUserDto } from './dto/suspend-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';

/** The audited subject, however much of it the handler gave back. */
function userLabel(ctx: AuditContext, result: unknown): string {
  return (
    readString(result, 'fullName') ??
    readString(result, 'email') ??
    ctx.params.id ??
    'user'
  );
}

function userId(ctx: AuditContext, result: unknown): string | undefined {
  return (
    readString(result, 'id') ?? readString(result, 'userId') ?? ctx.params.id
  );
}

/**
 * Route order is significant. `stats` and `export` are declared before `:id`
 * because Nest matches in declaration order — put them after and
 * `GET /users/stats` is served by `findOne('stats')`, which fails the UUID pipe
 * and never reaches the handler meant to answer it.
 */
@ApiTags('users')
@ApiBearerAuth('access-token')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @RequirePermissions(PERMISSION_CODES.USERS_VIEW)
  @Get()
  @ApiOperation({
    summary: 'List users with pagination, search, filters and sorting',
  })
  findAll(@Query() query: QueryUsersDto) {
    return this.usersService.findAll(query);
  }

  @RequirePermissions(PERMISSION_CODES.USERS_VIEW)
  @Get('stats')
  @ApiOperation({ summary: 'Aggregate counts powering the dashboard cards' })
  stats() {
    return this.usersService.stats();
  }

  @RequirePermissions(PERMISSION_CODES.USERS_VIEW)
  @Get('export')
  @ApiOperation({
    summary: 'Stream matching users as CSV, honouring the GET /users filters',
  })
  @ApiOkResponse({ description: 'A text/csv attachment.' })
  async exportCsv(
    @Query() query: QueryUsersDto,
    // @Res() puts this handler in library-specific mode: nothing is returned to
    // Nest, so TransformInterceptor never wraps the body in the JSON envelope
    // and the client receives raw CSV.
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${this.usersService.exportFilename()}"`,
    );

    for await (const chunk of this.usersService.streamCsv(query)) {
      response.write(chunk);
    }

    response.end();
  }

  @RequirePermissions(PERMISSION_CODES.USERS_VIEW)
  @Get(':id')
  @ApiOperation({ summary: 'Fetch one user' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.findOne(id);
  }

  @RequirePermissions(PERMISSION_CODES.USERS_VIEW)
  @Get(':id/balance')
  @ApiOperation({ summary: 'Current balance, as a two-decimal string' })
  getBalance(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.getBalance(id);
  }

  @RequirePermissions(PERMISSION_CODES.USERS_MANAGE)
  @AuditLog({
    category: ActivityCategory.USER,
    action: ACTIVITY_ACTIONS.USER_CREATED.code,
    title: (ctx, result) => `New user ${userLabel(ctx, result)} created`,
    entityType: 'User',
    entityId: userId,
  })
  @Post()
  @ApiOperation({ summary: 'Create a user from the admin panel' })
  create(
    @Body() createUserDto: CreateUserDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.usersService.create(createUserDto, admin);
  }

  @RequirePermissions(PERMISSION_CODES.USERS_MANAGE)
  @AuditLog({
    category: ActivityCategory.USER,
    action: ACTIVITY_ACTIONS.USER_BALANCE_ADJUSTED.code,
    title: (ctx, result) =>
      `Balance adjusted by ${readString(result, 'amount') ?? 'an unknown amount'} for ${userLabel(ctx, result)}`,
    description: (_ctx, result) => readString(result, 'reason'),
    entityType: 'User',
    entityId: userId,
    // The result carries both sides of the move, so this is a genuine
    // before/after rather than a snapshot of the new value.
    metadata: (_ctx, result) => ({
      changes: computeDiff(
        { balance: readString(result, 'previousBalance') },
        { balance: readString(result, 'balance') },
      ),
      amount: readString(result, 'amount'),
      reason: readString(result, 'reason'),
    }),
  })
  @Post(':id/balance/adjust')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Credit or debit a balance; negative amounts debit',
  })
  adjustBalance(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() adjustBalanceDto: AdjustBalanceDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.usersService.adjustBalance(id, adjustBalanceDto, admin);
  }

  @RequirePermissions(PERMISSION_CODES.USERS_MANAGE)
  @AuditLog({
    category: ActivityCategory.USER,
    action: ACTIVITY_ACTIONS.USER_UPDATED.code,
    title: (ctx, result) => `User ${userLabel(ctx, result)} updated`,
    entityType: 'User',
    entityId: userId,
    // The submitted fields, not a before/after: the pre-update row lives inside
    // UsersService and never reaches the interceptor. Recording what was asked
    // for is still the useful half — see the report note on this trade-off.
    metadata: (ctx) => ({ submitted: ctx.body }),
  })
  @Patch(':id')
  @ApiOperation({ summary: 'Update a user' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    return this.usersService.update(id, updateUserDto);
  }

  @RequirePermissions(PERMISSION_CODES.USERS_MANAGE)
  @AuditLog({
    category: ActivityCategory.USER,
    action: ACTIVITY_ACTIONS.USER_SUSPENDED.code,
    title: (ctx, result) => `User ${userLabel(ctx, result)} suspended`,
    description: (ctx) => readString(ctx.body, 'reason'),
    entityType: 'User',
    entityId: userId,
    // No before/after: the previous status is not fabricated here because the
    // interceptor cannot see it, and a guessed "from" in an audit log is worse
    // than none at all.
    metadata: (ctx, result) => ({
      reason: readString(ctx.body, 'reason'),
      status: readString(result, 'status'),
    }),
  })
  @Patch(':id/suspend')
  @ApiOperation({ summary: 'Suspend a user; a reason is required' })
  suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() suspendUserDto: SuspendUserDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.usersService.suspend(id, suspendUserDto.reason, admin);
  }

  @RequirePermissions(PERMISSION_CODES.USERS_MANAGE)
  @AuditLog({
    category: ActivityCategory.USER,
    action: ACTIVITY_ACTIONS.USER_ACTIVATED.code,
    title: (ctx, result) => `User ${userLabel(ctx, result)} activated`,
    entityType: 'User',
    entityId: userId,
  })
  @Patch(':id/activate')
  @ApiOperation({ summary: 'Return a user to ACTIVE' })
  activate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.usersService.activate(id, admin);
  }

  @RequirePermissions(PERMISSION_CODES.USERS_MANAGE)
  @AuditLog({
    category: ActivityCategory.USER,
    action: ACTIVITY_ACTIONS.USER_DELETED.code,
    // The 204 sends no body, but the handler's return value still reaches the
    // interceptor — so the audit title can name the person rather than log a
    // bare UUID nobody can read.
    title: (ctx, result) =>
      `User ${readString(result, 'fullName') ?? ctx.params.id ?? 'unknown'} deleted`,
    entityType: 'User',
    entityId: (ctx) => ctx.params.id,
  })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Soft delete: sets deletedAt and status=DELETED, keeping history',
  })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.remove(id);
  }
}
