/**
 * The storage contract every module talks to (docs/01-ARCHITECTURE.md, ADR-003).
 *
 * Local disk was chosen for Milestone 1, but nothing outside this folder knows
 * that. `cloudinary` is already a dependency and three `CLOUDINARY_*` variables
 * already sit in `env.validation.ts`, so a migration is likely — writing a
 * `CloudinaryStorageService` later becomes a one-line provider swap in
 * `storage.module.ts` instead of a rewrite across the tournament, reward and
 * merchandise modules.
 */

/**
 * The subset of a Multer file this layer needs.
 *
 * Deliberately structural rather than `Express.Multer.File`: `@types/multer` is
 * not installed (multer 2 ships no types of its own), and depending on an
 * ambient global from a package we do not have would make the build fragile.
 * A real Multer file satisfies this shape, and so does a processed buffer that
 * never came from a request — which is exactly what the image pipeline hands in.
 */
export interface StorageUploadFile {
  /** The bytes to store. Memory storage is used, so this is always populated. */
  buffer: Buffer;
  mimetype: string;
  /**
   * Client-supplied and therefore untrusted. Used only to pick a sensible
   * extension — never as a path component. See `LocalDiskStorageService`.
   */
  originalname?: string;
}

/** What a storage backend returns once bytes are durably written. */
export interface StoredFile {
  /**
   * Storage-relative key, e.g. `tournaments/1f0c….webp`. This is what gets
   * persisted on `MediaAsset.key` and handed back to `delete()`.
   */
  key: string;
  /** Absolute, publicly reachable URL for the stored bytes. */
  url: string;
  mimeType: string;
  sizeBytes: number;
}

export interface StorageService {
  upload(file: StorageUploadFile, folder: string): Promise<StoredFile>;
  delete(key: string): Promise<void>;
  getUrl(key: string): string;
}

/**
 * Injection token for the interface above.
 *
 * An interface has no runtime representation, so Nest cannot use it as a
 * provider token — this symbol-free string constant is the indirection that
 * makes `@Inject(STORAGE_SERVICE)` work.
 */
export const STORAGE_SERVICE = 'STORAGE_SERVICE';
