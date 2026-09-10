import {
  ConflictException,
  Injectable,
  Module,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ActivityCategory,
  ItemStatus,
  Prisma,
  ShipmentStatus,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

import { PERMISSION_CODES } from '../../common/constants/permissions';
import { ACTIVITY_ACTIONS } from '../../common/constants/activity-actions';
import {
  AuditLog,
  readString,
} from '../../common/decorators/audit-log.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import {
  buildPaginationMeta,
  PaginationQueryDto,
} from '../../common/dto/pagination.dto';
import type { Paginated } from '../../common/interceptors/transform.interceptor';
import {
  initialsOf,
  joinFullName,
} from '../../common/text/split-full-name.util';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../auth/interfaces/authenticated-admin.interface';
import { PrismaService } from '../prisma/prisma.service';
import { recordLedgerEntry } from '../transactions/repositories/transactions.repository';

/* ----------------------------------------------------------------- shapes */

const SHIPMENT_INCLUDE = {
  user: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
    },
  },
  merchandise: { select: { id: true, name: true } },
  variant: { select: { id: true, size: true, color: true, sku: true } },
} satisfies Prisma.ShipmentInclude;

type ShipmentWithRelations = Prisma.ShipmentGetPayload<{
  include: typeof SHIPMENT_INCLUDE;
}>;

/** The immutable destination snapshot stored on the shipment. */
export interface ShippingAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  /** False when any required line is missing — a shipment cannot go out. */
  isComplete: boolean;
}

export interface ShipmentItem {
  id: string;
  user: {
    id: string;
    fullName: string;
    initials: string;
    email: string;
  };
  address: ShippingAddress;
  merchandiseName: string;
  variant: {
    size: string | null;
    color: string | null;
    sku: string | null;
  } | null;
  customisation: string | null;
  status: ShipmentStatus;
  carrier: string | null;
  trackingNumber: string | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
}

function toShipmentItem(shipment: ShipmentWithRelations): ShipmentItem {
  const user = shipment.user;

  // A parcel needs a street, a city and a country at minimum. Anything less
  // and "Create shipment" would produce an undeliverable record.
  const isComplete = Boolean(
    shipment.addressLine1 &&
    shipment.city &&
    shipment.postalCode &&
    shipment.country,
  );

  return {
    id: shipment.id,
    user: {
      id: user.id,
      fullName: joinFullName(user.firstName, user.lastName),
      initials: initialsOf(user.firstName, user.lastName),
      email: user.email,
    },
    address: {
      line1: shipment.addressLine1 || null,
      line2: shipment.addressLine2,
      city: shipment.city || null,
      state: shipment.state || null,
      postalCode: shipment.postalCode || null,
      country: shipment.country || null,
      isComplete,
    },
    merchandiseName: shipment.merchandise.name,
    variant: shipment.variant
      ? {
          size: shipment.variant.size,
          color: shipment.variant.color,
          sku: shipment.variant.sku,
        }
      : null,
    customisation: shipment.customisation,
    status: shipment.status,
    carrier: shipment.carrier,
    trackingNumber: shipment.trackingNumber,
    shippedAt: shipment.shippedAt,
    deliveredAt: shipment.deliveredAt,
    createdAt: shipment.createdAt,
  };
}

/* -------------------------------------------------------------------- dto */

export class QueryShipmentsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ShipmentStatus })
  @IsOptional()
  @IsEnum(ShipmentStatus)
  status?: ShipmentStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;
}

export class CreateShipmentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  merchandiseId!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  variantId?: string;

  @ApiPropertyOptional({ example: 'Engrave: Ada Lovelace' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  customisation?: string;
}

export class UpdateShipmentDto {
  @ApiPropertyOptional({ enum: ShipmentStatus })
  @IsOptional()
  @IsEnum(ShipmentStatus)
  status?: ShipmentStatus;

  @ApiPropertyOptional({ example: 'UPS' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  carrier?: string;

  @ApiPropertyOptional({ example: '1Z999AA10123456784' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  trackingNumber?: string;
}

/* --------------------------------------------------------------- service */

@Injectable()
export class ShipmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: QueryShipmentsDto): Promise<Paginated<ShipmentItem[]>> {
    const where: Prisma.ShipmentWhereInput = {};

    if (query.status) where.status = query.status;
    if (query.userId) where.userId = query.userId;

    if (query.search?.trim()) {
      const contains: Prisma.StringFilter = {
        contains: query.search.trim(),
        mode: 'insensitive',
      };

      where.OR = [
        { user: { firstName: contains } },
        { user: { lastName: contains } },
        { user: { email: contains } },
        { merchandise: { name: contains } },
        { trackingNumber: contains },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.shipment.findMany({
        where,
        include: SHIPMENT_INCLUDE,
        orderBy: [{ createdAt: 'desc' }],
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.shipment.count({ where }),
    ]);

    return {
      data: rows.map(toShipmentItem),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async create(
    dto: CreateShipmentDto,
    admin: AuthenticatedAdmin,
  ): Promise<ShipmentItem> {
    const shipment = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: dto.userId } });
      if (!user) throw new NotFoundException(`User ${dto.userId} not found`);
      if (
        !user.addressLine1 ||
        !user.city ||
        !user.postalCode ||
        !user.country
      ) {
        throw new UnprocessableEntityException(
          'The player needs a complete street, city, postal code and country before shipment creation.',
        );
      }

      const merchandise = await tx.merchandise.findFirst({
        where: {
          id: dto.merchandiseId,
          deletedAt: null,
          status: ItemStatus.ACTIVE,
        },
      });
      if (!merchandise) {
        throw new NotFoundException(
          `Merchandise ${dto.merchandiseId} not found`,
        );
      }
      if (!dto.variantId) {
        throw new UnprocessableEntityException(
          'A merchandise variant is required.',
        );
      }
      const variant = await tx.merchandiseVariant.findFirst({
        where: { id: dto.variantId, merchandiseId: merchandise.id },
      });
      if (!variant) {
        throw new UnprocessableEntityException(
          'The selected variant does not belong to this product.',
        );
      }
      const reserved = await tx.merchandiseVariant.updateMany({
        where: { id: variant.id, stock: { gt: 0 } },
        data: { stock: { decrement: 1 } },
      });
      if (reserved.count !== 1) {
        throw new ConflictException('The selected variant is out of stock.');
      }

      return tx.shipment.create({
        data: {
          userId: dto.userId,
          merchandiseId: dto.merchandiseId,
          variantId: variant.id,
          customisation: dto.customisation?.trim() || null,
          tokenCost: 0,
          shippingName: joinFullName(user.firstName, user.lastName),
          addressLine1: user.addressLine1,
          addressLine2: user.addressLine2,
          city: user.city,
          state: user.state ?? '',
          postalCode: user.postalCode,
          country: user.country,
          createdByAdminId: admin.id,
        },
        include: SHIPMENT_INCLUDE,
      });
    });

    return toShipmentItem(shipment);
  }

  async update(id: string, dto: UpdateShipmentDto): Promise<ShipmentItem> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.shipment.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException(`Shipment ${id} not found`);

      const data: Prisma.ShipmentUncheckedUpdateInput = {};
      if (dto.carrier !== undefined) data.carrier = dto.carrier.trim() || null;
      if (dto.trackingNumber !== undefined) {
        data.trackingNumber = dto.trackingNumber.trim() || null;
      }

      if (dto.status !== undefined && dto.status !== existing.status) {
        const allowed: Record<ShipmentStatus, ShipmentStatus[]> = {
          [ShipmentStatus.PENDING]: [
            ShipmentStatus.IN_TRANSIT,
            ShipmentStatus.CANCELLED,
          ],
          [ShipmentStatus.IN_TRANSIT]: [ShipmentStatus.DELIVERED],
          [ShipmentStatus.DELIVERED]: [],
          [ShipmentStatus.CANCELLED]: [],
        };
        if (!allowed[existing.status].includes(dto.status)) {
          throw new ConflictException(
            `Shipment cannot move from ${existing.status} to ${dto.status}.`,
          );
        }
        data.status = dto.status;
        if (dto.status === ShipmentStatus.IN_TRANSIT && !existing.shippedAt) {
          data.shippedAt = new Date();
        }
        if (dto.status === ShipmentStatus.DELIVERED && !existing.deliveredAt) {
          data.deliveredAt = new Date();
        }
        if (dto.status === ShipmentStatus.CANCELLED) {
          data.cancelledAt = new Date();
          if (existing.variantId) {
            await tx.merchandiseVariant.update({
              where: { id: existing.variantId },
              data: { stock: { increment: 1 } },
            });
          }
          if (existing.purchaseTransactionId && !existing.refundTransactionId) {
            const refund = await recordLedgerEntry(tx, {
              userId: existing.userId,
              type: TransactionType.REFUND,
              amount: existing.tokenCost,
              status: TransactionStatus.COMPLETED,
              reference: `merchandise-refund:${id}`,
              description: 'Cancelled merchandise claim refunded by admin',
            });
            if (refund.outcome !== 'RECORDED') {
              throw new Error(`Merchandise refund failed: ${refund.outcome}`);
            }
            data.refundTransactionId = refund.transaction.id;
          }
        }
      }

      return tx.shipment.update({
        where: { id },
        data,
        include: SHIPMENT_INCLUDE,
      });
    });
    return toShipmentItem(updated);
  }
}

/* ------------------------------------------------------------- controller */

/**
 * Merchandise fulfilment.
 *
 * The destination is read from the address already on `User`, which the
 * create-user modal and the registration webhook collect. A second address
 * model would be a second thing to keep correct.
 */
@ApiTags('shipments')
@ApiBearerAuth('access-token')
@Controller('shipments')
export class ShipmentsController {
  constructor(private readonly service: ShipmentsService) {}

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get()
  @ApiOperation({ summary: 'List shipments, newest first' })
  findAll(@Query() query: QueryShipmentsDto) {
    return this.service.findAll(query);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @AuditLog({
    category: ActivityCategory.MERCHANDISE,
    action: ACTIVITY_ACTIONS.SHIPMENT_CREATED.code,
    title: (_ctx, result) =>
      `Shipment ${readString(result, 'id') ?? 'created'}`,
    entityType: 'Shipment',
    entityId: (_ctx, result) => readString(result, 'id'),
  })
  @Post()
  @ApiOperation({
    summary:
      'Create a shipment. The row carries `address.isComplete` so the UI can ' +
      'refuse to dispatch to an address missing a street, city or country.',
  })
  create(
    @Body() dto: CreateShipmentDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.service.create(dto, admin);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @AuditLog({
    category: ActivityCategory.MERCHANDISE,
    action: ACTIVITY_ACTIONS.SHIPMENT_UPDATED.code,
    title: (ctx) => `Shipment ${ctx.params.id} updated`,
    entityType: 'Shipment',
    entityId: (ctx) => ctx.params.id,
    metadata: (ctx) => ({ submitted: ctx.body }),
  })
  @Patch(':id')
  @ApiOperation({
    summary:
      'Update status or tracking. shippedAt and deliveredAt are stamped once ' +
      'and never moved by a later edit.',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateShipmentDto,
  ) {
    return this.service.update(id, dto);
  }
}

@Module({
  controllers: [ShipmentsController],
  providers: [ShipmentsService],
  exports: [ShipmentsService],
})
export class ShipmentsModule {}
