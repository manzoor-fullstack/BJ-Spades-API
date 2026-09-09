import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';

export class CorrectTournamentResultsDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Stable idempotency key for this correction.',
  })
  @IsUUID('4')
  requestId!: string;

  @ApiProperty({
    type: [String],
    description: 'The two members of the corrected champion team.',
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsUUID('4', { each: true })
  championUserIds!: string[];

  @ApiProperty({
    type: [String],
    description: 'The two members of the corrected runner-up team.',
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsUUID('4', { each: true })
  runnerUpUserIds!: string[];

  @ApiProperty({ minLength: 5, maxLength: 500 })
  @IsString()
  @Length(5, 500)
  reason!: string;
}
