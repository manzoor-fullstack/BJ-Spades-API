import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class RegisterPlayerDto {
  @ApiProperty({ format: 'uuid', description: 'The user to register.' })
  @IsUUID()
  userId: string;
}
