import {
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiProperty,
  ApiPropertyOptional,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Prisma, TreasuryWallet } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { PERMISSION_CODES } from '../../common/constants/permissions';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A treasury wallet as the Crypto tab renders it.
 *
 * `balance` is a figure an operator recorded, NOT a chain read. There is no
 * block-explorer client and no contract call anywhere in this system, so the
 * prototype's "Smart contract verified" badge has nothing behind it and is not
 * produced here. `balanceRecordedAt` is exposed precisely so the UI can say
 * how stale the number is.
 */
export interface TreasuryWalletItem {
  id: string;
  label: string;
  address: string;
  network: string;
  currency: string;
  /** Fixed-point string, 8dp. Never a float — this is a balance. */
  balance: string;
  balanceRecordedAt: Date | null;
  isActive: boolean;
  createdAt: Date;
}

function toTreasuryWalletItem(wallet: TreasuryWallet): TreasuryWalletItem {
  return {
    id: wallet.id,
    label: wallet.label,
    address: wallet.address,
    network: wallet.network,
    currency: wallet.currency,
    balance: wallet.balance.toFixed(8),
    balanceRecordedAt: wallet.balanceRecordedAt,
    isActive: wallet.isActive,
    createdAt: wallet.createdAt,
  };
}

export class CreateWalletDto {
  @ApiProperty({ example: 'Prize treasury' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  label!: string;

  @ApiProperty({ example: '0xBJ5p4d35A1b2C3d4' })
  @IsString()
  @MinLength(4)
  @MaxLength(200)
  address!: string;

  @ApiProperty({ example: 'polygon' })
  @IsString()
  @MaxLength(60)
  network!: string;

  @ApiProperty({ example: 'USDC' })
  @IsString()
  @MaxLength(20)
  currency!: string;
}

export class UpdateWalletDto {
  @ApiPropertyOptional({ example: 142890.5 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0)
  balance?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ example: 'Prize treasury' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

@Injectable()
export class TreasuryService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<TreasuryWalletItem[]> {
    const wallets = await this.prisma.treasuryWallet.findMany({
      orderBy: [{ isActive: 'desc' }, { label: 'asc' }],
    });

    return wallets.map(toTreasuryWalletItem);
  }

  async create(dto: CreateWalletDto): Promise<TreasuryWalletItem> {
    return toTreasuryWalletItem(
      await this.prisma.treasuryWallet.create({
        data: {
          label: dto.label.trim(),
          address: dto.address.trim(),
          network: dto.network.trim(),
          currency: dto.currency.trim().toUpperCase(),
        },
      }),
    );
  }

  async update(id: string, dto: UpdateWalletDto): Promise<TreasuryWalletItem> {
    await this.getOrThrow(id);

    const data: Prisma.TreasuryWalletUpdateInput = {};

    if (dto.label !== undefined) data.label = dto.label.trim();
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    if (dto.balance !== undefined) {
      // Converted through a string: `new Decimal(0.1 + 0.2)` is not 0.3, and
      // this is a treasury balance.
      data.balance = new Prisma.Decimal(dto.balance.toFixed(8));
      // Stamped on every balance write, so the UI can say how stale it is.
      // Nothing reads this from chain — an operator typed it.
      data.balanceRecordedAt = new Date();
    }

    return toTreasuryWalletItem(
      await this.prisma.treasuryWallet.update({ where: { id }, data }),
    );
  }

  async remove(id: string): Promise<{ id: string }> {
    await this.getOrThrow(id);

    return this.prisma.treasuryWallet.delete({
      where: { id },
      select: { id: true },
    });
  }

  private async getOrThrow(id: string): Promise<TreasuryWallet> {
    const wallet = await this.prisma.treasuryWallet.findUnique({
      where: { id },
    });

    if (!wallet) throw new NotFoundException(`Wallet ${id} not found`);

    return wallet;
  }
}

@ApiTags('treasury')
@ApiBearerAuth('access-token')
@Controller('treasury')
export class TreasuryController {
  constructor(private readonly service: TreasuryService) {}

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_VIEW)
  @Get('wallets')
  @ApiOperation({
    summary:
      'Treasury wallets. Balances are operator-recorded figures, not chain ' +
      'reads — balanceRecordedAt says when each was last entered.',
  })
  findAll() {
    return this.service.findAll();
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @Post('wallets')
  @ApiOperation({ summary: 'Record a treasury wallet' })
  create(@Body() dto: CreateWalletDto) {
    return this.service.create(dto);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @Patch('wallets/:id')
  @ApiOperation({
    summary:
      'Update a wallet. Writing a balance stamps balanceRecordedAt, because ' +
      'a figure nobody can date is a figure nobody should trust.',
  })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWalletDto) {
    return this.service.update(id, dto);
  }

  @RequirePermissions(PERMISSION_CODES.PAYOUTS_MANAGE)
  @Delete('wallets/:id')
  @ApiOperation({ summary: 'Remove a treasury wallet' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }
}

@Module({
  controllers: [TreasuryController],
  providers: [TreasuryService],
  exports: [TreasuryService],
})
export class TreasuryModule {}
