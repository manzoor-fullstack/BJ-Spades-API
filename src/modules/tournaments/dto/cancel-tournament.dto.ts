import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/**
 * Cancelling requires a reason, and the requirement lives here rather than in
 * the UI alone.
 *
 * The reason is stored on `Tournament.cancelReason` and copied into the audit
 * entry; once Phase 6 refunds entry fees it is what players are told. A
 * cancellation with no recorded reason is unanswerable three weeks later.
 */
export class CancelTournamentDto {
  @ApiProperty({ example: 'Venue unavailable', minLength: 3, maxLength: 500 })
  @IsString()
  @Length(3, 500)
  reason: string;
}
