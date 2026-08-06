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

import { CreateMerchandiseDto } from './dto/create-merchandise.dto';
import { QueryMerchandiseDto } from './dto/query-merchandise.dto';
import { UpdateMerchandiseDto } from './dto/update-merchandise.dto';
import { CreateVariantDto, UpdateVariantDto } from './dto/variant.dto';
import { MerchandiseService } from './merchandise.service';

/** The audited subject, however much of it the handler gave back. */
function productLabel(ctx: AuditContext, result: unknown): string {
  return readString(result, 'name') ?? ctx.params.id ?? 'merchandise';
}

function productId(ctx: AuditContext, result: unknown): string | undefined {
  return readString(result, 'id') ?? ctx.params.id;
}

/** Variant handlers return the variant, so the product id comes from the URL. */
function variantLabel(_ctx: AuditContext, result: unknown): string {
  return readString(result, 'sku') ?? readString(result, 'id') ?? 'variant';
}

@ApiTags('merchandise')
@ApiBearerAuth('access-token')
@Controller('merchandise')
export class MerchandiseController {
  constructor(private readonly merchandiseService: MerchandiseService) {}

  @RequirePermissions(PERMISSION_CODES.REWARDS_MANAGE)
  @Get()
  @ApiOperation({
    summary:
      'List merchandise with pagination, status filter, name search and sorting. Rows carry variantCount and totalStock.',
  })
  findAll(@Query() query: QueryMerchandiseDto) {
    return this.merchandiseService.findAll(query);
  }

  @RequirePermissions(PERMISSION_CODES.REWARDS_MANAGE)
  @Get(':id')
  @ApiOperation({ summary: 'Fetch one product with its variants' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.merchandiseService.findOne(id);
  }

  @RequirePermissions(PERMISSION_CODES.REWARDS_MANAGE)
  @AuditLog({
    category: ActivityCategory.MERCHANDISE,
    action: ACTIVITY_ACTIONS.MERCHANDISE_CREATED.code,
    title: (ctx, result) => `Merchandise ${productLabel(ctx, result)} created`,
    entityType: 'Merchandise',
    entityId: productId,
  })
  @Post()
  @UseInterceptors(ImageUploadInterceptor('image'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: CreateMerchandiseDto })
  @ApiOperation({
    summary:
      'Create a product. multipart/form-data with an optional `image` and a `variants` JSON array; the product and its variants are written in one transaction.',
  })
  create(
    @Body() createMerchandiseDto: CreateMerchandiseDto,
    @UploadedFile() image: ValidatableUpload | undefined,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.merchandiseService.create(createMerchandiseDto, image, admin);
  }

  @RequirePermissions(PERMISSION_CODES.REWARDS_MANAGE)
  @AuditLog({
    category: ActivityCategory.MERCHANDISE,
    action: ACTIVITY_ACTIONS.MERCHANDISE_UPDATED.code,
    title: (ctx, result) => `Merchandise ${productLabel(ctx, result)} updated`,
    entityType: 'Merchandise',
    entityId: productId,
    // What was asked for, not a before/after: the pre-update row lives inside
    // MerchandiseService and never reaches the interceptor.
    metadata: (ctx) => ({ submitted: ctx.body }),
  })
  @Patch(':id')
  @UseInterceptors(ImageUploadInterceptor('image'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UpdateMerchandiseDto })
  @ApiOperation({
    summary:
      'Update a product. Variants are managed through the variant endpoints, not here.',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateMerchandiseDto: UpdateMerchandiseDto,
    @UploadedFile() image: ValidatableUpload | undefined,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.merchandiseService.update(
      id,
      updateMerchandiseDto,
      image,
      admin,
    );
  }

  @RequirePermissions(PERMISSION_CODES.REWARDS_MANAGE)
  @AuditLog({
    category: ActivityCategory.MERCHANDISE,
    action: ACTIVITY_ACTIONS.MERCHANDISE_DELETED.code,
    title: (ctx, result) => `Merchandise ${productLabel(ctx, result)} deleted`,
    entityType: 'Merchandise',
    entityId: (ctx) => ctx.params.id,
  })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Soft-delete a product. Its variants stay attached so a Milestone 2 order can still name what was bought.',
  })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.merchandiseService.remove(id);
  }

  @RequirePermissions(PERMISSION_CODES.REWARDS_MANAGE)
  @AuditLog({
    category: ActivityCategory.MERCHANDISE,
    action: ACTIVITY_ACTIONS.MERCHANDISE_VARIANT_ADDED.code,
    title: (ctx, result) =>
      `Variant ${variantLabel(ctx, result)} added to merchandise ${ctx.params.id}`,
    entityType: 'Merchandise',
    entityId: (ctx) => ctx.params.id,
    metadata: (_ctx, result) => ({ sku: readString(result, 'sku') }),
  })
  @Post(':id/variants')
  @ApiOperation({
    summary:
      'Add a variant. The SKU is generated from the product id, size and colour when omitted; a supplied one that collides returns 409.',
  })
  addVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() createVariantDto: CreateVariantDto,
  ) {
    return this.merchandiseService.addVariant(id, createVariantDto);
  }

  @RequirePermissions(PERMISSION_CODES.REWARDS_MANAGE)
  @AuditLog({
    category: ActivityCategory.MERCHANDISE,
    action: ACTIVITY_ACTIONS.MERCHANDISE_VARIANT_UPDATED.code,
    title: (ctx, result) =>
      `Variant ${variantLabel(ctx, result)} updated on merchandise ${ctx.params.id}`,
    entityType: 'Merchandise',
    entityId: (ctx) => ctx.params.id,
    metadata: (ctx) => ({
      variantId: ctx.params.vid,
      submitted: ctx.body,
    }),
  })
  @Patch(':id/variants/:vid')
  @ApiOperation({ summary: 'Update one variant of a product' })
  updateVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vid', ParseUUIDPipe) vid: string,
    @Body() updateVariantDto: UpdateVariantDto,
  ) {
    return this.merchandiseService.updateVariant(id, vid, updateVariantDto);
  }

  @RequirePermissions(PERMISSION_CODES.REWARDS_MANAGE)
  @AuditLog({
    category: ActivityCategory.MERCHANDISE,
    action: ACTIVITY_ACTIONS.MERCHANDISE_VARIANT_REMOVED.code,
    title: (ctx, result) =>
      `Variant ${variantLabel(ctx, result)} removed from merchandise ${ctx.params.id}`,
    entityType: 'Merchandise',
    entityId: (ctx) => ctx.params.id,
    metadata: (ctx, result) => ({
      variantId: ctx.params.vid,
      sku: readString(result, 'sku'),
    }),
  })
  @Delete(':id/variants/:vid')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Remove a variant. A hard delete — a variant has no deletedAt, and its SKU becomes available again.',
  })
  removeVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vid', ParseUUIDPipe) vid: string,
  ) {
    return this.merchandiseService.removeVariant(id, vid);
  }
}
