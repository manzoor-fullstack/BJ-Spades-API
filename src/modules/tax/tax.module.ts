import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiProperty,
  ApiPropertyOptional,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  Prisma,
  TaxDocumentKind,
  TaxDocumentStatus,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { PERMISSION_CODES } from '../../common/constants/permissions';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import {
  buildPaginationMeta,
  PaginationQueryDto,
} from '../../common/dto/pagination.dto';
import type { Paginated } from '../../common/interceptors/transform.interceptor';
import { formatMoney, toMoney } from '../../common/money/money.util';
import {
  initialsOf,
  joinFullName,
} from '../../common/text/split-full-name.util';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The US reporting threshold that triggers a 1099.
 *
 * Encoded here so the figure has one home. This is a *calculation*, not tax
 * advice, and crossing it does not itself produce a filing.
 */
export const REPORTABLE_THRESHOLD = 600;

const TAX_INCLUDE = {
  user: { select: { id: true, firstName: true, lastName: true, email: true } },
  mediaAsset: { select: { id: true, url: true } },
} satisfies Prisma.TaxDocumentInclude;

type TaxDocumentWithRelations = Prisma.TaxDocumentGetPayload<{
  include: typeof TAX_INCLUDE;
}>;

export interface TaxDocumentItem {
  id: string;
  user: { id: string; fullName: string; initials: string; email: string };
  kind: TaxDocumentKind;
  taxYear: number;
  status: TaxDocumentStatus;
  fileUrl: string | null;
  note: string | null;
  createdAt: Date;
}

export interface TaxThresholdRow {
  user: { id: string; fullName: string; email: string };
  /** Two-decimal string: completed prize earnings this tax year. */
  earned: string;
  /** Two-decimal string. Zero once the threshold is crossed. */
  remaining: string;
  isReportable: boolean;
  hasTaxDocument: boolean;
}

function toTaxDocumentItem(row: TaxDocumentWithRelations): TaxDocumentItem {
  return {
    id: row.id,
    user: {
      id: row.user.id,
      fullName: joinFullName(row.user.firstName, row.user.lastName),
      initials: initialsOf(row.user.firstName, row.user.lastName),
      email: row.user.email,
    },
    kind: row.kind,
    taxYear: row.taxYear,
    status: row.status,
    fileUrl: row.mediaAsset?.url ?? null,
    note: row.note,
    createdAt: row.createdAt,
  };
}

export class QueryTaxDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: TaxDocumentKind })
  @IsOptional()
  @IsEnum(TaxDocumentKind)
  kind?: TaxDocumentKind;

  @ApiPropertyOptional({ example: 2026 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  taxYear?: number;
}

export class RecordTaxDocumentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ enum: TaxDocumentKind })
  @IsEnum(TaxDocumentKind)
  kind!: TaxDocumentKind;

  @ApiProperty({ example: 2026 })
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  taxYear!: number;

  /** An already-uploaded file, via the existing media pipeline. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  mediaAssetId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ReviewTaxDocumentDto {
  @ApiProperty({ enum: TaxDocumentStatus })
  @IsEnum(TaxDocumentStatus)
  status!: TaxDocumentStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

@Injectable()
export class TaxService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: QueryTaxDto): Promise<Paginated<TaxDocumentItem[]>> {
    const where: Prisma.TaxDocumentWhereInput = {};

    if (query.kind) where.kind = query.kind;
    if (query.taxYear) where.taxYear = query.taxYear;

    if (query.search?.trim()) {
      const contains: Prisma.StringFilter = {
        contains: query.search.trim(),
        mode: 'insensitive',
      };

      where.OR = [
        { user: { firstName: contains } },
        { user: { lastName: contains } },
        { user: { email: contains } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.taxDocument.findMany({
        where,
        include: TAX_INCLUDE,
        orderBy: [{ taxYear: 'desc' }, { createdAt: 'desc' }],
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.taxDocument.count({ where }),
    ]);

    return {
      data: rows.map(toTaxDocumentItem),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  /**
   * Who is at or near the reportable threshold this tax year.
   *
   * Counts COMPLETED prize transactions only: money that was promised but
   * never sent is not earnings, and reporting it would overstate what a player
   * owes tax on.
   */
  async thresholds(taxYear: number): Promise<TaxThresholdRow[]> {
    const start = new Date(Date.UTC(taxYear, 0, 1));
    const end = new Date(Date.UTC(taxYear + 1, 0, 1));

    const grouped = await this.prisma.transaction.groupBy({
      by: ['userId'],
      where: {
        type: TransactionType.PRIZE,
        status: TransactionStatus.COMPLETED,
        createdAt: { gte: start, lt: end },
      },
      _sum: { amount: true },
    });

    if (grouped.length === 0) return [];

    const userIds = grouped.map((row) => row.userId);

    const [users, documents] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, firstName: true, lastName: true, email: true },
      }),
      this.prisma.taxDocument.findMany({
        where: { userId: { in: userIds }, taxYear },
        select: { userId: true },
      }),
    ]);

    const byId = new Map(users.map((user) => [user.id, user]));
    const withDocument = new Set(documents.map((doc) => doc.userId));
    const threshold = toMoney(REPORTABLE_THRESHOLD);

    return grouped
      .map((row) => {
        const user = byId.get(row.userId);
        if (!user) return null;

        const earned = row._sum.amount ?? toMoney(0);
        const remaining = threshold.sub(earned);

        return {
          user: {
            id: user.id,
            fullName: joinFullName(user.firstName, user.lastName),
            email: user.email,
          },
          earned: formatMoney(earned),
          remaining: formatMoney(remaining.lessThan(0) ? 0 : remaining),
          isReportable: earned.greaterThanOrEqualTo(threshold),
          hasTaxDocument: withDocument.has(row.userId),
        };
      })
      .filter((row): row is TaxThresholdRow => row !== null)
      .sort((a, b) => Number(b.earned) - Number(a.earned));
  }

  async record(dto: RecordTaxDocumentDto): Promise<TaxDocumentItem> {
    const row = await this.prisma.taxDocument.upsert({
      where: {
        userId_kind_taxYear: {
          userId: dto.userId,
          kind: dto.kind,
          taxYear: dto.taxYear,
        },
      },
      update: {
        mediaAssetId: dto.mediaAssetId ?? null,
        note: dto.note?.trim() || null,
      },
      create: {
        userId: dto.userId,
        kind: dto.kind,
        taxYear: dto.taxYear,
        mediaAssetId: dto.mediaAssetId ?? null,
        note: dto.note?.trim() || null,
      },
      include: TAX_INCLUDE,
    });

    return toTaxDocumentItem(row);
  }

  async review(
    id: string,
    dto: ReviewTaxDocumentDto,
  ): Promise<TaxDocumentItem> {
    const existing = await this.prisma.taxDocument.findUnique({
      where: { id },
    });

    if (!existing) throw new NotFoundException(`Tax document ${id} not found`);

    return toTaxDocumentItem(
      await this.prisma.taxDocument.update({
        where: { id },
        data: { status: dto.status, note: dto.note?.trim() || existing.note },
        include: TAX_INCLUDE,
      }),
    );
  }
}

/**
 * Tax document capture and the reportable-threshold calculation.
 *
 * This module records documents and computes who has crossed the $600 US
 * reporting threshold. It does NOT generate a 1099 — producing a filing-valid
 * form is a compliance product, and the UI says so rather than offering a
 * download that would look official and not be.
 */
@ApiTags('tax')
@ApiBearerAuth('access-token')
@Controller('tax')
export class TaxController {
  constructor(private readonly service: TaxService) {}

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get('documents')
  @ApiOperation({ summary: 'Captured tax documents, newest year first' })
  findAll(@Query() query: QueryTaxDto) {
    return this.service.findAll(query);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get('thresholds')
  @ApiOperation({
    summary:
      'Players by earnings against the $600 reportable threshold. Completed ' +
      'prize transactions only — money promised but never sent is not income.',
  })
  thresholds(@Query('taxYear') taxYear?: string) {
    const year = Number(taxYear);

    return this.service.thresholds(
      Number.isInteger(year) && year > 2000 ? year : new Date().getFullYear(),
    );
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @Post('documents')
  @ApiOperation({
    summary:
      'Record a tax document for a player. Upserts on (player, kind, year).',
  })
  record(@Body() dto: RecordTaxDocumentDto) {
    return this.service.record(dto);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @Patch('documents/:id')
  @ApiOperation({ summary: 'Accept or reject a captured document' })
  review(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewTaxDocumentDto,
  ) {
    return this.service.review(id, dto);
  }
}

@Module({
  controllers: [TaxController],
  providers: [TaxService],
  exports: [TaxService],
})
export class TaxModule {}
