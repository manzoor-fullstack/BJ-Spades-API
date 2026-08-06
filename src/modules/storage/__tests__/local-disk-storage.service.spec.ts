import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ConfigService } from '@nestjs/config';

import { LocalDiskStorageService } from '../local-disk-storage.service';

/** Just the `get` calls the service makes, typed without pulling in Nest DI. */
function configStub(uploadDir: string, publicUrl: string): ConfigService {
  const values: Record<string, string> = {
    'app.uploadDir': uploadDir,
    'app.publicUrl': publicUrl,
  };

  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

describe('LocalDiskStorageService', () => {
  let rootDir: string;
  let service: LocalDiskStorageService;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'bjs-storage-'));
    service = new LocalDiskStorageService(
      configStub(rootDir, 'http://localhost:5001/'),
    );
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('names the stored file after a generated UUID, never the uploaded name', async () => {
    const stored = await service.upload(
      {
        buffer: Buffer.from('image-bytes'),
        mimetype: 'image/webp',
        originalname: 'my holiday photo.WEBP',
      },
      'tournaments',
    );

    expect(stored.key).toMatch(
      /^tournaments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/,
    );
    expect(stored.key).not.toContain('holiday');
  });

  it('sanitises a traversal filename by ignoring it entirely', async () => {
    // `../../etc/passwd` as an upload filename is a routine probe. Because the
    // key is a UUID and the extension comes from the verified MIME type, none
    // of it reaches the path.
    const stored = await service.upload(
      {
        buffer: Buffer.from('image-bytes'),
        mimetype: 'image/webp',
        originalname: '../../etc/passwd',
      },
      'tournaments',
    );

    expect(stored.key).not.toContain('..');
    expect(stored.key).not.toContain('passwd');

    const written = resolve(rootDir, stored.key);
    expect(written.startsWith(resolve(rootDir))).toBe(true);
    await expect(stat(written)).resolves.toBeDefined();
  });

  it('writes the exact bytes it was given and reports their length', async () => {
    const buffer = Buffer.from('the quick brown fox');

    const stored = await service.upload(
      { buffer, mimetype: 'image/webp' },
      'tournaments',
    );

    expect(stored.sizeBytes).toBe(buffer.length);
    await expect(readFile(resolve(rootDir, stored.key))).resolves.toEqual(
      buffer,
    );
  });

  it('builds a public URL under /uploads with no duplicated slash', () => {
    expect(service.getUrl('tournaments/abc.webp')).toBe(
      'http://localhost:5001/uploads/tournaments/abc.webp',
    );
  });

  it('rejects a folder name that is not a plain slug', async () => {
    await expect(
      service.upload(
        { buffer: Buffer.from('x'), mimetype: 'image/webp' },
        '..',
      ),
    ).rejects.toThrow(/Unsafe storage folder/);
  });

  it('deletes a file it created', async () => {
    const stored = await service.upload(
      { buffer: Buffer.from('x'), mimetype: 'image/webp' },
      'tournaments',
    );

    await service.delete(stored.key);

    await expect(stat(resolve(rootDir, stored.key))).rejects.toThrow();
  });

  it('refuses to act on a key that escapes the upload root', async () => {
    const outsider = join(rootDir, 'outside.txt');
    await writeFile(outsider, 'do not delete me');

    await service.delete('../outside.txt');
    await service.delete('/etc/passwd');
    await service.delete('tournaments/../../outside.txt');

    // Still there: an unrecognised key is logged and ignored, not resolved.
    await expect(readFile(outsider, 'utf8')).resolves.toBe('do not delete me');
  });

  it('treats deleting an already-missing file as success', async () => {
    await expect(
      service.delete('tournaments/00000000-0000-4000-8000-000000000000.webp'),
    ).resolves.toBeUndefined();
  });
});
