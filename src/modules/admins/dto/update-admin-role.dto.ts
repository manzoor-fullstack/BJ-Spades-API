import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class UpdateAdminRoleDto {
  @ApiProperty({ description: 'The role to move this admin to' })
  @IsUUID()
  roleId: string;
}
