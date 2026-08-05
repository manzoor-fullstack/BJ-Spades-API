import { ApiProperty } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsString } from 'class-validator';

/**
 * A full replacement of the role's permission set, not a diff.
 *
 * The modal submits every checkbox on each save, so replacing the set matches
 * what the user sees; diffing would need the client to track which boxes
 * changed (docs/phases/PHASE-3.md, task 3.8). An empty array is valid and means
 * "this role grants nothing".
 */
export class UpdateRolePermissionsDto {
  @ApiProperty({
    type: [String],
    example: ['users.manage', 'tournaments.manage', 'activity.view'],
  })
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissionCodes: string[];
}
