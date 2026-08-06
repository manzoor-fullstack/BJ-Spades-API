import { ApiPropertyOptional } from '@nestjs/swagger';
import { TournamentStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

/** `search` from the base DTO covers the tournament name. */
export class QueryTournamentsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: TournamentStatus })
  @IsOptional()
  @IsEnum(TournamentStatus)
  status?: TournamentStatus;
}
