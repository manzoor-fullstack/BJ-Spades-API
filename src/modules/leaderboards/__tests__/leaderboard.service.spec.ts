import { LeaderboardPeriod } from '../dto/leaderboard-query.dto';
import { LeaderboardRepository } from '../leaderboard.repository';
import { LeaderboardService } from '../leaderboard.service';

describe('LeaderboardService cache', () => {
  it('reuses an unchanged projection and invalidates it when the repository revision changes', async () => {
    const source = jest.fn().mockResolvedValue({ players: [], matches: [] });
    const repository = {
      revision: jest
        .fn()
        .mockResolvedValueOnce('v1')
        .mockResolvedValueOnce('v1')
        .mockResolvedValueOnce('v2'),
      source,
    } as unknown as LeaderboardRepository;
    const service = new LeaderboardService(repository);
    const query = { period: LeaderboardPeriod.TODAY, page: 1, limit: 10 };

    await service.leaderboard('viewer', query);
    await service.leaderboard('viewer', query);
    await service.leaderboard('viewer', query);

    expect(source).toHaveBeenCalledTimes(2);
  });
});
