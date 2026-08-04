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
import type { Response } from 'express';

import { PERMISSION_CODES } from '../../common/constants/permissions';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../auth/interfaces/authenticated-admin.interface';

import { AdjustBalanceDto } from './dto/adjust-balance.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';
import { SuspendUserDto } from './dto/suspend-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';

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
  @Post()
  @ApiOperation({ summary: 'Create a user from the admin panel' })
  create(
    @Body() createUserDto: CreateUserDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.usersService.create(createUserDto, admin);
  }

  @RequirePermissions(PERMISSION_CODES.USERS_MANAGE)
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
  @Patch(':id')
  @ApiOperation({ summary: 'Update a user' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    return this.usersService.update(id, updateUserDto);
  }

  @RequirePermissions(PERMISSION_CODES.USERS_MANAGE)
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
  @Patch(':id/activate')
  @ApiOperation({ summary: 'Return a user to ACTIVE' })
  activate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.usersService.activate(id, admin);
  }

  @RequirePermissions(PERMISSION_CODES.USERS_MANAGE)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Soft delete: sets deletedAt and status=DELETED, keeping history',
  })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.remove(id);
  }
}
