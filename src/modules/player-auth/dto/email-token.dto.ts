import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class EmailTokenDto {
  @ApiProperty()
  @IsString()
  @Length(64, 64)
  token: string;
}
