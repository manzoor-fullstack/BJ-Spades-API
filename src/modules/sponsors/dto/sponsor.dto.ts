import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { SponsorStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class QuerySponsorsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: SponsorStatus })
  @IsOptional()
  @IsEnum(SponsorStatus)
  status?: SponsorStatus;
}

export class CreateSponsorDto {
  @ApiProperty({ example: 'RedBull Esports' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: '$2,000 bonus + branded swag' })
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  prizeDescription!: string;

  @ApiProperty({ example: 2000 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  // Guards against a fat-fingered value that would misstate a prize pool.
  @Max(10_000_000)
  value!: number;

  @ApiProperty({ example: '10% affiliate' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  splitType!: string;

  @ApiProperty({ example: 'partners@redbull.com' })
  @IsEmail()
  contactEmail!: string;

  @ApiPropertyOptional({ enum: SponsorStatus })
  @IsOptional()
  @IsEnum(SponsorStatus)
  status?: SponsorStatus;
}

export class UpdateSponsorDto extends PartialType(CreateSponsorDto) {}
