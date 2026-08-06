import type { MediaAsset } from '@prisma/client';

import type { ImageProcessorService } from '../image-processor.service';
import { MediaService, ORPHAN_GRACE_PERIOD_MS } from '../media.service';
import type { MediaRepository } from '../repositories/media.repository';
import type { StorageService } from '../storage.interface';

type MockedRepository = { [K in keyof MediaRepository]: jest.Mock };
type MockedStorage = { [K in keyof StorageService]: jest.Mock };
type MockedProcessor = { [K in keyof ImageProcessorService]: jest.Mock };

function assetFixture(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-1',
    key: 'tournaments/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp',
    url: 'http://localhost:5001/uploads/tournaments/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp',
    mimeType: 'image/webp',
    sizeBytes: 1234,
    width: 1200,
    height: 675,
    uploadedByAdminId: 'admin-1',
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('MediaService', () => {
  let repository: MockedRepository;
  let storage: MockedStorage;
  let processor: MockedProcessor;
  let service: MediaService;

  beforeEach(() => {
    repository = {
      create: jest.fn(),
      findById: jest.fn(),
      deleteById: jest.fn().mockResolvedValue(undefined),
      findOrphans: jest.fn().mockResolvedValue([]),
    };

    storage = {
      upload: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
      getUrl: jest.fn(),
    };

    processor = { process: jest.fn() };

    service = new MediaService(
      repository as unknown as MediaRepository,
      processor as unknown as ImageProcessorService,
      storage,
    );
  });

  describe('uploadImage', () => {
    it('records the measured dimensions and size, not what the client claimed', async () => {
      processor.process.mockResolvedValue({
        buffer: Buffer.alloc(4096),
        mimeType: 'image/webp',
        sizeBytes: 4096,
        width: 1200,
        height: 675,
      });
      storage.upload.mockResolvedValue({
        key: 'tournaments/x.webp',
        url: 'http://localhost:5001/uploads/tournaments/x.webp',
        mimeType: 'image/webp',
        sizeBytes: 4096,
      });
      repository.create.mockResolvedValue(assetFixture());

      await service.uploadImage(
        { buffer: Buffer.alloc(10), mimetype: 'image/png', size: 999_999 },
        'tournaments',
        'admin-1',
      );

      const [data] = repository.create.mock.calls[0] as [
        Record<string, unknown>,
      ];

      expect(data).toMatchObject({
        mimeType: 'image/webp',
        sizeBytes: 4096,
        width: 1200,
        height: 675,
        uploadedByAdminId: 'admin-1',
      });
    });

    it('never writes a row when processing rejects the file', async () => {
      processor.process.mockRejectedValue(new Error('not an image'));

      await expect(
        service.uploadImage(
          { buffer: Buffer.alloc(4), mimetype: 'image/png' },
          'tournaments',
          null,
        ),
      ).rejects.toThrow('not an image');

      expect(storage.upload).not.toHaveBeenCalled();
      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  describe('deleteAsset', () => {
    it('deletes the row before the bytes', async () => {
      repository.findById.mockResolvedValue(assetFixture());

      await service.deleteAsset('asset-1');

      expect(repository.deleteById).toHaveBeenCalledWith('asset-1');
      expect(storage.delete).toHaveBeenCalledWith(assetFixture().key);
      expect(repository.deleteById.mock.invocationCallOrder[0]).toBeLessThan(
        storage.delete.mock.invocationCallOrder[0]!,
      );
    });

    it('does nothing when there is no asset id', async () => {
      await service.deleteAsset(null);
      await service.deleteAsset(undefined);

      expect(repository.findById).not.toHaveBeenCalled();
    });

    it('swallows a storage failure so the caller can still finish', async () => {
      repository.findById.mockResolvedValue(assetFixture());
      storage.delete.mockRejectedValue(new Error('disk unavailable'));

      await expect(service.deleteAsset('asset-1')).resolves.toBeUndefined();
    });
  });

  describe('cleanupOrphans', () => {
    it('only considers assets older than the grace period', async () => {
      const now = new Date('2026-05-02T12:00:00.000Z');

      await service.cleanupOrphans(now);

      const [cutoff] = repository.findOrphans.mock.calls[0] as [Date];

      // Anything newer could belong to a tournament being created right now:
      // the asset row is written before the row that references it.
      expect(cutoff.getTime()).toBe(now.getTime() - ORPHAN_GRACE_PERIOD_MS);
    });

    it('deletes each orphan row and its file, and reports the totals', async () => {
      repository.findOrphans.mockResolvedValue([
        assetFixture({ id: 'a', key: 'tournaments/a.webp' }),
        assetFixture({ id: 'b', key: 'tournaments/b.webp' }),
      ]);

      await expect(service.cleanupOrphans()).resolves.toEqual({
        scanned: 2,
        deleted: 2,
      });

      expect(storage.delete).toHaveBeenCalledWith('tournaments/a.webp');
      expect(storage.delete).toHaveBeenCalledWith('tournaments/b.webp');
    });

    it('keeps going when one orphan fails and reports the shortfall', async () => {
      repository.findOrphans.mockResolvedValue([
        assetFixture({ id: 'a' }),
        assetFixture({ id: 'b' }),
      ]);
      repository.deleteById.mockRejectedValueOnce(new Error('locked'));

      await expect(service.cleanupOrphans()).resolves.toEqual({
        scanned: 2,
        deleted: 1,
      });
    });
  });
});
