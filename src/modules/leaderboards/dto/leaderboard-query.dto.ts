import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

export enum LeaderboardPeriod {
  TODAY = 'today',
  WEEK = 'week',
  MONTH = 'month',
  SEASON = 'season',
  ALL_TIME = 'all-time',
}

export class LeaderboardQueryDto {
  @ApiPropertyOptional({
    enum: LeaderboardPeriod,
    default: LeaderboardPeriod.TODAY,
  })
  @IsOptional()
  @IsEnum(LeaderboardPeriod)
  period: LeaderboardPeriod = LeaderboardPeriod.TODAY;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 10;
}
