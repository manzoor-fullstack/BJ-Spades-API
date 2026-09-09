import { IsUUID } from 'class-validator';

export class CreateFriendRequestDto {
  @IsUUID()
  playerId: string;
}
