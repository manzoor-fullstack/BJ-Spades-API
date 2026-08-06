import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

import { toBooleanFlag } from '../../../common/dto/enum-token.transform';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class QuerySecurityAlertsDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description:
      'Return only high-priority entries. The feed otherwise covers everything filed under SECURITY as well.',
    default: false,
  })
  @IsOptional()
  // Implicit conversion turns the string "false" into `true`, so the raw value
  // is read off the query object instead. See enum-token.transform.ts.
  @Transform(toBooleanFlag)
  @IsBoolean()
  highPriorityOnly: boolean = false;
}
