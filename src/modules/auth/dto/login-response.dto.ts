import { ApiProperty } from '@nestjs/swagger';

export class AuthTokensDto {
  @ApiProperty({ description: 'Short-lived access token (JWT)' })
  accessToken: string;

  @ApiProperty({ description: 'Rotating refresh token (JWT)' })
  refreshToken: string;

  @ApiProperty({
    description: 'Access token lifetime in seconds',
    example: 900,
  })
  expiresIn: number;
}

export class AuthenticatedAdminDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ example: 'SUPER_ADMIN' })
  role: string;

  @ApiProperty({ example: 'Super Administrator' })
  roleDisplayName: string;

  @ApiProperty({
    type: [String],
    example: ['users.manage', 'tournaments.manage'],
  })
  permissions: string[];
}

export class AuthResponseDto extends AuthTokensDto {
  @ApiProperty({ type: AuthenticatedAdminDto })
  admin: AuthenticatedAdminDto;
}
