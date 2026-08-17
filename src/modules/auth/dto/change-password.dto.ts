import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

/**
 * Self-service password change.
 *
 * `MinLength(8)` matches `CreateAdminDto`, so a password an admin sets for
 * themselves is held to the same rule as one set for them. There is no
 * `confirmPassword`: confirmation is a UI concern and sending it here would
 * put a third copy of the secret on the wire for no gain.
 */
export class ChangePasswordDto {
  @ApiProperty({ description: 'The password being replaced.' })
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  newPassword: string;
}
