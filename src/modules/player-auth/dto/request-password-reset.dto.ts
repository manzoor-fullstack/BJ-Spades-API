import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';

export class RequestPasswordResetDto {
  @ApiProperty({ example: 'player@example.com' })
  @IsEmail()
  @MaxLength(255)
  email: string;
}
