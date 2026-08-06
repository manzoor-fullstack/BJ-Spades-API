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
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../auth/interfaces/authenticated-admin.interface';
import { ImageUploadInterceptor } from '../storage/image-upload.interceptor';
import type { ValidatableUpload } from '../storage/image-validation';

import { CreateRewardDto } from './dto/create-reward.dto';
import { QueryRewardsDto } from './dto/query-rewards.dto';
import { UpdateRewardDto } from './dto/update-reward.dto';
import { RewardsService } from './rewards.service';

/** The audited subject, however much of it the handler gave back. */
function rewardLabel(ctx: AuditContext, result: unknown): string {
  return readString(result, 'name') ?? ctx.params.id ?? 'reward';
}

function rewardId(ctx: AuditContext, result: unknown): string | undefined {
  return readString(result, 'id') ?? ctx.params.id;
}

@ApiTags('rewards')
@ApiBearerAuth('access-token')
@Controller('rewards')
export class RewardsController {
  constructor(private readonly rewardsService: RewardsService) {}

  @RequirePermissions(PERMISSION_CODES.REWARDS_MANAGE)
  @Get()
  @ApiOperation({
    summary:
      'List rewards with pagination, status and category filters, search on name or company, and sorting',
  })
  findAll(@Query() query: QueryRewardsDto) {
    return this.rewardsService.findAll(query);
  }

  @RequirePermissions(PERMISSION_CODES.REWARDS_MANAGE)
  @Get(':id')
  @ApiOperation({ summary: 'Fetch one reward. Soft-deleted rewards 404.' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.rewardsService.findOne(id);
  }

  @RequirePermissions(PERMISSION_CODES.REWARDS_MANAGE)
  @AuditLog({
    category: ActivityCategory.REWARD,
    action: ACTIVITY_ACTIONS.REWARD_CREATED.code,
    title: (ctx, result) => `Reward ${rewardLabel(ctx, result)} created`,
    entityType: 'Reward',
    entityId: rewardId,
  })
  @Post()
  @UseInterceptors(ImageUploadInterceptor('image'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: CreateRewardDto })
  @ApiOperation({
    summary:
      'Create a reward. multipart/form-data with an optional `image`; field names mirror create-reward-modal.tsx.',
  })
  create(
    @Body() createRewardDto: CreateRewardDto,
    @UploadedFile() image: ValidatableUpload | undefined,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.rewardsService.create(createRewardDto, image, admin);
  }

  @RequirePermissions(PERMISSION_CODES.REWARDS_MANAGE)
  @AuditLog({
    category: ActivityCategory.REWARD,
    action: ACTIVITY_ACTIONS.REWARD_UPDATED.code,
    title: (ctx, result) => `Reward ${rewardLabel(ctx, result)} updated`,
    entityType: 'Reward',
    entityId: rewardId,
    // What was asked for, not a before/after: the pre-update row lives inside
    // RewardsService and never reaches the interceptor.
    metadata: (ctx) => ({ submitted: ctx.body }),
  })
  @Patch(':id')
  @UseInterceptors(ImageUploadInterceptor('image'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UpdateRewardDto })
  @ApiOperation({
    summary:
      'Update a reward. Supplying an `image` replaces the icon and deletes the old file.',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateRewardDto: UpdateRewardDto,
    @UploadedFile() image: ValidatableUpload | undefined,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.rewardsService.update(id, updateRewardDto, image, admin);
  }

  @RequirePermissions(PERMISSION_CODES.REWARDS_MANAGE)
  @AuditLog({
    category: ActivityCategory.REWARD,
    action: ACTIVITY_ACTIONS.REWARD_DELETED.code,
    title: (ctx, result) => `Reward ${rewardLabel(ctx, result)} deleted`,
    entityType: 'Reward',
    entityId: (ctx) => ctx.params.id,
  })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Soft-delete a reward. The row and its image survive so Milestone 2 redemption history stays intact.',
  })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.rewardsService.remove(id);
  }
}
