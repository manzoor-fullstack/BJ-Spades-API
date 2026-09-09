import { IsUUID } from 'class-validator';

export class CreateChallengeDto {
  @IsUUID()
  requestId: string;

  @IsUUID()
  friendId: string;
}
