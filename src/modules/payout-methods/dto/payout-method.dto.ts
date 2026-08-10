import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PayoutMethod } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class QueryPayoutMethodsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PayoutMethod })
  @IsOptional()
  @IsEnum(PayoutMethod)
  method?: PayoutMethod;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;
}

export class ConnectPayoutMethodDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ enum: PayoutMethod })
  @IsEnum(PayoutMethod)
  method!: PayoutMethod;

  @ApiPropertyOptional({ example: 'Chase checking' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  /**
   * A handle, masked account number or wallet address — never a full
   * credential. This system deliberately stores nothing it would then be
   * responsible for protecting.
   */
  @ApiProperty({ example: 'xxxx4471' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  reference!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isVerified?: boolean;
}
