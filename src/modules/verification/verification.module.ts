import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiPropertyOptional,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Prisma, VerificationCheckState } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

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

/**
 * The six checks, in the order the matrix renders them.
 *
 * Every one is **recorded by an admin**. There is no KYC provider, no
 * age-verification service and no fraud engine in this system — this is the
 * record of a human decision, and the UI must not present it as an automated
 * result.
 */
export const VERIFICATION_CHECKS = [
  { key: 'kycCheck', label: 'KYC Verification' },
  { key: 'ageCheck', label: 'Age Verification (18+)' },
  { key: 'countryCheck', label: 'Country Eligibility' },
  { key: 'taxCheck', label: 'Tax Information (W9/W8BEN)' },
  { key: 'walletCheck', label: 'Wallet Address Verified' },
  { key: 'fraudCheck', label: 'Fraud Risk Scan' },
] as const;

export type VerificationCheckKey = (typeof VERIFICATION_CHECKS)[number]['key'];

const VERIFICATION_INCLUDE = {
  user: { select: { id: true, firstName: true, lastName: true, email: true } },
} satisfies Prisma.PlayerVerificationInclude;

type VerificationWithUser = Prisma.PlayerVerificationGetPayload<{
  include: typeof VERIFICATION_INCLUDE;
}>;

export interface VerificationCheck {
  key: VerificationCheckKey;
  label: string;
  state: VerificationCheckState;
}

export interface PlayerVerificationItem {
  id: string;
  user: { id: string; fullName: string; initials: string; email: string };
  country: string | null;
  walletAddress: string | null;
  checks: VerificationCheck[];
  /** How many checks have PASSED, out of the ones that apply. */
  passed: number;
  /** Checks that are not NOT_REQUIRED — the denominator of the progress badge. */
  applicable: number;
  /** True only when every applicable check has passed. */
  isFullyVerified: boolean;
  /** At least one check has failed — the row an operator acts on. */
  needsAction: boolean;
  note: string | null;
  lastCheckedAt: Date | null;
}

export interface VerificationStats {
  playersTracked: number;
  fullyVerified: number;
  actionRequired: number;
  walletsRecorded: number;
}

function toVerificationItem(row: VerificationWithUser): PlayerVerificationItem {
  const checks: VerificationCheck[] = VERIFICATION_CHECKS.map((check) => ({
    key: check.key,
    label: check.label,
    state: row[check.key],
  }));

  // NOT_REQUIRED is excluded from the denominator on purpose: a non-US player
  // with no W9 to file is not 5/6 verified, they are fully verified.
  const applicable = checks.filter(
    (check) => check.state !== VerificationCheckState.NOT_REQUIRED,
  ).length;

  const passed = checks.filter(
    (check) => check.state === VerificationCheckState.PASSED,
  ).length;

  return {
    id: row.id,
    user: {
      id: row.user.id,
      fullName: joinFullName(row.user.firstName, row.user.lastName),
      initials: initialsOf(row.user.firstName, row.user.lastName),
      email: row.user.email,
    },
    country: row.country,
    walletAddress: row.walletAddress,
    checks,
    passed,
    applicable,
    isFullyVerified: applicable > 0 && passed === applicable,
    needsAction: checks.some(
      (check) => check.state === VerificationCheckState.FAILED,
    ),
    note: row.note,
    lastCheckedAt: row.lastCheckedAt,
  };
}

export class QueryVerificationDto extends PaginationQueryDto {}

export class UpdateVerificationDto {
  @ApiPropertyOptional({ enum: VerificationCheckState })
  @IsOptional()
  @IsEnum(VerificationCheckState)
  kycCheck?: VerificationCheckState;

  @ApiPropertyOptional({ enum: VerificationCheckState })
  @IsOptional()
  @IsEnum(VerificationCheckState)
  ageCheck?: VerificationCheckState;

  @ApiPropertyOptional({ enum: VerificationCheckState })
  @IsOptional()
  @IsEnum(VerificationCheckState)
  countryCheck?: VerificationCheckState;

  @ApiPropertyOptional({ enum: VerificationCheckState })
  @IsOptional()
  @IsEnum(VerificationCheckState)
  taxCheck?: VerificationCheckState;

  @ApiPropertyOptional({ enum: VerificationCheckState })
  @IsOptional()
  @IsEnum(VerificationCheckState)
  walletCheck?: VerificationCheckState;

  @ApiPropertyOptional({ enum: VerificationCheckState })
  @IsOptional()
  @IsEnum(VerificationCheckState)
  fraudCheck?: VerificationCheckState;

  @ApiPropertyOptional({ example: 'US' })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;

  @ApiPropertyOptional({ example: '0x4f3a8b21' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  walletAddress?: string;

  @ApiPropertyOptional({ example: 'Passport checked against submitted name.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

@Injectable()
export class VerificationService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    query: QueryVerificationDto,
  ): Promise<Paginated<PlayerVerificationItem[]>> {
    const where: Prisma.PlayerVerificationWhereInput = {};

    if (query.search?.trim()) {
      const contains: Prisma.StringFilter = {
        contains: query.search.trim(),
        mode: 'insensitive',
      };

      where.OR = [
        { user: { firstName: contains } },
        { user: { lastName: contains } },
        { user: { email: contains } },
        { walletAddress: contains },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.playerVerification.findMany({
        where,
        include: VERIFICATION_INCLUDE,
        orderBy: [{ updatedAt: 'desc' }],
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.playerVerification.count({ where }),
    ]);

    return {
      data: rows.map(toVerificationItem),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async stats(): Promise<VerificationStats> {
    const rows = await this.prisma.playerVerification.findMany({
      include: VERIFICATION_INCLUDE,
    });

    const items = rows.map(toVerificationItem);

    return {
      playersTracked: items.length,
      fullyVerified: items.filter((item) => item.isFullyVerified).length,
      actionRequired: items.filter((item) => item.needsAction).length,
      walletsRecorded: items.filter((item) => Boolean(item.walletAddress))
        .length,
    };
  }

  /**
   * Records an admin's decision on one or more checks.
   *
   * Upserts: a player with no verification row yet gets one on first edit,
   * rather than needing a separate create step nobody would remember.
   */
  async update(
    userId: string,
    dto: UpdateVerificationDto,
    admin: AuthenticatedAdmin,
  ): Promise<PlayerVerificationItem> {
    const data = {
      ...(dto.kycCheck !== undefined ? { kycCheck: dto.kycCheck } : {}),
      ...(dto.ageCheck !== undefined ? { ageCheck: dto.ageCheck } : {}),
      ...(dto.countryCheck !== undefined
        ? { countryCheck: dto.countryCheck }
        : {}),
      ...(dto.taxCheck !== undefined ? { taxCheck: dto.taxCheck } : {}),
      ...(dto.walletCheck !== undefined
        ? { walletCheck: dto.walletCheck }
        : {}),
      ...(dto.fraudCheck !== undefined ? { fraudCheck: dto.fraudCheck } : {}),
      ...(dto.country !== undefined
        ? { country: dto.country.trim().toUpperCase() || null }
        : {}),
      ...(dto.walletAddress !== undefined
        ? { walletAddress: dto.walletAddress.trim() || null }
        : {}),
      ...(dto.note !== undefined ? { note: dto.note.trim() || null } : {}),
      lastCheckedAt: new Date(),
      lastCheckedByAdminId: admin.id,
    };

    const row = await this.prisma.playerVerification.upsert({
      where: { userId },
      update: data,
      create: { userId, ...data },
      include: VERIFICATION_INCLUDE,
    });

    return toVerificationItem(row);
  }
}

/**
 * Per-player identity, eligibility and risk checks.
 *
 * Every check here is a recorded human decision. Nothing in this system
 * performs KYC, verifies an age, or scans for fraud.
 */
@ApiTags('verification')
@ApiBearerAuth('access-token')
@Controller('verification')
export class VerificationController {
  constructor(private readonly service: VerificationService) {}

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get()
  @ApiOperation({ summary: 'Per-player verification matrix' })
  findAll(@Query() query: QueryVerificationDto) {
    return this.service.findAll(query);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get('stats')
  @ApiOperation({
    summary:
      'The four Verification cards. A player whose only outstanding checks ' +
      'are NOT_REQUIRED counts as fully verified.',
  })
  stats() {
    return this.service.stats();
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @Patch(':userId')
  @ApiOperation({
    summary:
      'Record a decision on one or more checks. Upserts, so a player with no ' +
      'row yet gets one on first edit.',
  })
  update(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateVerificationDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.service.update(userId, dto, admin);
  }
}

@Module({
  controllers: [VerificationController],
  providers: [VerificationService],
  exports: [VerificationService],
})
export class VerificationModule {}
