import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class SuspendUserDto {
  @ApiProperty({ example: 'Suspected fraudulent activity', minLength: 3 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}
