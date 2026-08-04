import { ApiProperty } from '@nestjs/swagger';
import { IsJWT, IsNotEmpty, IsString } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({
    description: 'The refresh token issued at login or last refresh',
  })
  @IsString()
  @IsNotEmpty()
  @IsJWT()
  refreshToken: string;
}
