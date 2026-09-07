import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

const AVATAR_NAMES = [
  'Big Ace',
  'Queen Bee',
  'The DJ',
  '"Lil" Hustle',
  'Poppa Cool',
  'Ace of Spades',
  'The Scholar',
  "Mama's Boy",
  'Lady Luck',
  'The Neighborhood Legend',
] as const;

const optionalText = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const requiredText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class UpdatePlayerProfileDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 24 })
  @IsOptional()
  @Transform(requiredText)
  @IsString()
  @Length(3, 24)
  @Matches(/^[A-Za-z0-9_]+$/, {
    message: 'username may contain only letters, numbers, and underscores',
  })
  username?: string;

  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @Transform(requiredText)
  @IsString()
  @Length(1, 60)
  displayName?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 100 })
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(100)
  tagline?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 300 })
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(300)
  bio?: string | null;

  @ApiPropertyOptional({ minLength: 1, maxLength: 60 })
  @IsOptional()
  @Transform(requiredText)
  @IsString()
  @Length(1, 60)
  firstName?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 60 })
  @IsOptional()
  @Transform(requiredText)
  @IsString()
  @Length(1, 60)
  lastName?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 30 })
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(30)
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '1990-05-15' })
  @IsOptional()
  @Transform(optionalText)
  @IsDateString({ strict: true })
  dateOfBirth?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 120 })
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(120)
  location?: string | null;

  @ApiPropertyOptional({ enum: AVATAR_NAMES })
  @IsOptional()
  @IsIn(AVATAR_NAMES)
  avatarName?: string;

  @ApiPropertyOptional({ example: '#fbbf24' })
  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  avatarBackground?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 200 })
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(200)
  twitter?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 200 })
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(200)
  facebook?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 200 })
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(200)
  instagram?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 200 })
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(200)
  youtube?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 200 })
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(200)
  twitch?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 200 })
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(200)
  discord?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 200 })
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(200)
  website?: string | null;
}
