import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

/**
 * `page`, `limit`, `search`, `sortBy` and `sortOrder` come from the base class.
 *
 * Both role filters exist because the two callers differ: the table's dropdown
 * holds role ids from `GET /roles`, while a link such as
 * `/admin-users?role=SUPER_ADMIN` is written by hand.
 */
export class QueryAdminsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter by role id' })
  @IsOptional()
  @IsUUID()
  roleId?: string;

  @ApiPropertyOptional({ description: 'Filter by role name, e.g. SUPER_ADMIN' })
  @IsOptional()
  @IsString()
  role?: string;
}
