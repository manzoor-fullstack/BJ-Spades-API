import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Length, Matches, MaxLength } from 'class-validator';

export class PlayerSignupDto {
  @ApiProperty({ example: 'spades_master' })
  @IsString()
  @Length(3, 24)
  @Matches(/^[A-Za-z0-9_]+$/, {
    message: 'username may contain only letters, numbers, and underscores',
  })
  username: string;

  @ApiProperty({ example: 'player@example.com' })
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiProperty({ minLength: 10, maxLength: 128 })
  @IsString()
  @Length(10, 128)
  @Matches(/[a-z]/, { message: 'password must contain a lowercase letter' })
  @Matches(/[A-Z]/, { message: 'password must contain an uppercase letter' })
  @Matches(/[0-9]/, { message: 'password must contain a number' })
  password: string;
}
