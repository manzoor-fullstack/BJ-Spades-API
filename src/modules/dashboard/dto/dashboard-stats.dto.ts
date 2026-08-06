import { ApiProperty } from '@nestjs/swagger';

export class TotalUsersCardDto {
  @ApiProperty({
    example: 2847,
    description: 'count(User where deletedAt is null)',
  })
  value: number;

  @ApiProperty({
    example: 124,
    description: 'Users created during the current calendar month (UTC)',
  })
  change: number;

  @ApiProperty({ example: 'this month' })
  changeLabel: string;
}

export class TotalRevenueCardDto {
  @ApiProperty({
    example: '48290.00',
    description:
      'sum(Transaction.amount where type = ENTRY_FEE and status = COMPLETED), as a fixed two-decimal string',
  })
  value: string;

  @ApiProperty({
    example: 12.5,
    nullable: true,
    description:
      'This month against last month. Null when last month had no revenue — there is no baseline to compare against.',
  })
  changePercent: number | null;

  @ApiProperty({ example: 'from last month' })
  changeLabel: string;
}

export class ActiveTournamentsCardDto {
  @ApiProperty({
    example: 23,
    description:
      'count(Tournament where status in (REGISTERING, IN_PROGRESS)). Replaces the mock Active Games card — D-03.',
  })
  value: number;

  @ApiProperty({ example: '23 tournaments running' })
  subLabel: string;
}

export class PlatformGrowthCardDto {
  @ApiProperty({
    example: 18.2,
    nullable: true,
    description:
      'User growth this quarter against last. Null when the previous quarter added no users.',
  })
  value: number | null;

  @ApiProperty({ example: 'vs. last quarter' })
  changeLabel: string;
}

/** The four cards on the dashboard, each a real aggregate. */
export class DashboardStatsDto {
  @ApiProperty({ type: TotalUsersCardDto })
  totalUsers: TotalUsersCardDto;

  @ApiProperty({ type: TotalRevenueCardDto })
  totalRevenue: TotalRevenueCardDto;

  @ApiProperty({ type: ActiveTournamentsCardDto })
  activeTournaments: ActiveTournamentsCardDto;

  @ApiProperty({ type: PlatformGrowthCardDto })
  platformGrowth: PlatformGrowthCardDto;
}
