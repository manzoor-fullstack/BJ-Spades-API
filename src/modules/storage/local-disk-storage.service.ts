import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import {
  type StorageService,
  type StorageUploadFile,
  type StoredFile,
} from './storage.interface';

/** Extension chosen from the verified MIME type, never from the filename. */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const DEFAULT_EXTENSION = 'bin';

/** Folder names are ours, not the client's; this rejects anything unexpected. */
const SAFE_FOLDER = /^[a-z0-9][a-z0-9-]*$/;

/** A key we produced: `<folder>/<uuid>.<ext>`. Anything else is not ours. */
const SAFE_KEY = /^[a-z0-9][a-z0-9-]*\/[0-9a-f-]{36}\.[a-z0-9]+$/;

/**
 * Writes uploads to the directory named by `UPLOAD_DIR` and serves them from
 * `${PUBLIC_URL}/uploads/<key>` (docs/01-ARCHITECTURE.md, ADR-003).
 *
 * Known limitations, repeated in the Phase 8 deployment checklist: files live
 * on one machine's disk, container filesystems are ephemeral, Node itself
 * serves the bytes, and nothing backs them up. Each has a documented mitigation
 * — a persistent volume, a single instance or shared storage, and a CDN in
 * front of `/uploads`.
 */
@Injectable()
export class LocalDiskStorageService implements StorageService {
  private readonly logger = new Logger(LocalDiskStorageService.name);

  /** Absolute, so no later `join` can be confused by a relative segment. */
  private readonly rootDir: string;

  private readonly publicUrl: string;

  constructor(config: ConfigService) {
    const uploadDir = config.get<string>('app.uploadDir') ?? './uploads';

    this.rootDir = isAbsolute(uploadDir)
      ? uploadDir
      : resolve(process.cwd(), uploadDir);

    this.publicUrl = (
      config.get<string>('app.publicUrl') ?? 'http://localhost:5000'
    ).replace(/\/+$/, '');
  }

  /**
   * Stores the bytes under a generated UUID.
   *
   * The original filename is never part of the path. `../../etc/passwd` and
   * `shell.php.jpg` are both routine upload payloads; a v4 UUID plus an
   * extension derived from the *verified* MIME type means neither the name nor
   * the extension is ever attacker-influenced.
   */
  async upload(file: StorageUploadFile, folder: string): Promise<StoredFile> {
    const safeFolder = this.assertSafeFolder(folder);
    const extension = EXTENSION_BY_MIME[file.mimetype] ?? DEFAULT_EXTENSION;
    const key = `${safeFolder}/${randomUUID()}.${extension}`;
    const target = this.resolveKey(key);

    // Created on demand rather than at boot: the directory may live on a volume
    // that is mounted after the process starts.
    await mkdir(dirname(target), { recursive: true });

    await writeFile(target, file.buffer);

    return {
      key,
      url: this.getUrl(key),
      mimeType: file.mimetype,
      sizeBytes: file.buffer.length,
    };
  }

  /**
   * Removes a stored file. A key that is already gone is not an error — the row
   * that referenced it is being deleted either way, and refusing to finish that
   * because the bytes vanished first would leave the database inconsistent.
   */
  async delete(key: string): Promise<void> {
    let target: string;

    try {
      target = this.resolveKey(key);
    } catch (error) {
      // A key that does not match the shape we generate was not written by us.
      // Refusing to act on it is the point: this is where a crafted
      // `../../.env` would otherwise be deleted.
      this.logger.warn(
        `Refusing to delete an unrecognised storage key: ${key} (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      return;
    }

    await rm(target, { force: true });
  }

  getUrl(key: string): string {
    return `${this.publicUrl}/uploads/${key}`;
  }

  private assertSafeFolder(folder: string): string {
    if (!SAFE_FOLDER.test(folder)) {
      throw new Error(`Unsafe storage folder: ${folder}`);
    }

    return folder;
  }

  /**
   * Maps a key to an absolute path and proves the result is still inside the
   * upload root. The regex above should make this unreachable; it is kept
   * because a containment check is cheap and a traversal is not recoverable.
   */
  private resolveKey(key: string): string {
    if (!SAFE_KEY.test(key)) {
      throw new Error(`Unsafe storage key: ${key}`);
    }

    const target = resolve(join(this.rootDir, key));

    if (!target.startsWith(this.rootDir + sep)) {
      throw new Error(`Storage key escapes the upload root: ${key}`);
    }

    return target;
  }
}
