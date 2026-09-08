import { GameCommandType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export class SubmitGameCommandDto {
  @IsUUID()
  idempotencyKey: string;

  @IsInt()
  @Min(1)
  expectedVersion: number;

  @IsEnum(GameCommandType)
  type: GameCommandType;

  @ValidateIf(
    (input: SubmitGameCommandDto) => input.type === GameCommandType.BID,
  )
  @IsInt()
  @Min(0)
  @Max(13)
  bid?: number;

  @IsOptional()
  @IsBoolean()
  blindNil?: boolean;

  @ValidateIf(
    (input: SubmitGameCommandDto) => input.type === GameCommandType.PLAY_CARD,
  )
  @IsString()
  @Matches(/^(?:[2-9TJQKA])[CDHS]$/)
  card?: string;
}
