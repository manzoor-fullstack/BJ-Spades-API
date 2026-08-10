import { Injectable, Module, NotFoundException } from '@nestjs/common';
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
import { Prisma, ShipmentStatus } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

import { PERMISSION_CODES } from '../../common/constants/permissions';
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

/** The destination, assembled from the address already held on `User`. */
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
  const isComplete = Boolean(user.addressLine1 && user.city && user.country);

  return {
    id: shipment.id,
    user: {
      id: user.id,
      fullName: joinFullName(user.firstName, user.lastName),
      initials: initialsOf(user.firstName, user.lastName),
      email: user.email,
    },
    address: {
      line1: user.addressLine1,
      line2: user.addressLine2,
      city: user.city,
      state: user.state,
      postalCode: user.postalCode,
      country: user.country,
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
    const shipment = await this.prisma.shipment.create({
      data: {
        userId: dto.userId,
        merchandiseId: dto.merchandiseId,
        variantId: dto.variantId ?? null,
        customisation: dto.customisation?.trim() || null,
        createdByAdminId: admin.id,
      },
      include: SHIPMENT_INCLUDE,
    });

    return toShipmentItem(shipment);
  }

  async update(id: string, dto: UpdateShipmentDto): Promise<ShipmentItem> {
    const existing = await this.prisma.shipment.findUnique({ where: { id } });

    if (!existing) throw new NotFoundException(`Shipment ${id} not found`);

    const data: Prisma.ShipmentUpdateInput = {};

    if (dto.carrier !== undefined) data.carrier = dto.carrier.trim() || null;
    if (dto.trackingNumber !== undefined) {
      data.trackingNumber = dto.trackingNumber.trim() || null;
    }

    if (dto.status !== undefined) {
      data.status = dto.status;

      // Stamp the moment the status first says so, and only then: an operator
      // correcting a typo on a delivered parcel must not move its date.
      if (dto.status === ShipmentStatus.IN_TRANSIT && !existing.shippedAt) {
        data.shippedAt = new Date();
      }

      if (dto.status === ShipmentStatus.DELIVERED && !existing.deliveredAt) {
        data.deliveredAt = new Date();
      }
    }

    return toShipmentItem(
      await this.prisma.shipment.update({
        where: { id },
        data,
        include: SHIPMENT_INCLUDE,
      }),
    );
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
