import {
  BadRequestException,
  type NestInterceptor,
  type Type,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';

import {
  ALLOWED_IMAGE_MIME_TYPES,
  isAllowedImageMimeType,
  MAX_IMAGE_BYTES,
} from './image-validation';

/**
 * Multer configuration for a single optional image field.
 *
 * No `storage` and no `dest`, so multer keeps the part in memory. That is
 * deliberate: nothing untrusted should reach the filesystem before its magic
 * bytes have been checked and it has been re-encoded, and a disk-backed
 * temporary file would do exactly that.
 *
 * `limits.fileSize` is the first line of PHASE-4.md's validation order — busboy
 * aborts the stream the moment the limit is passed, so a 500 MB upload never
 * gets buffered. Nest's `transformException` turns the resulting
 * `LIMIT_FILE_SIZE` into a 413 without any help from us.
 */
export const IMAGE_UPLOAD_OPTIONS: MulterOptions = {
  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, callback) => {
    // The declared type only. The magic-byte check needs the whole buffer and
    // therefore runs later, in ImageProcessorService — this is just the cheap
    // rejection that avoids buffering an obviously wrong part.
    if (!isAllowedImageMimeType(file.mimetype)) {
      callback(
        new BadRequestException(
          `Unsupported image type "${file.mimetype}". Allowed: ${ALLOWED_IMAGE_MIME_TYPES.join(', ')}.`,
        ),
        false,
      );
      return;
    }

    callback(null, true);
  },
};

/**
 * `@UseInterceptors(ImageUploadInterceptor('image'))` on any multipart route.
 *
 * Wrapped in a function rather than exported as a constant so the field name
 * stays at the call site, and so Phase 5's reward and merchandise uploads reuse
 * the identical limits instead of copying them.
 */
export function ImageUploadInterceptor(field: string): Type<NestInterceptor> {
  return FileInterceptor(field, IMAGE_UPLOAD_OPTIONS);
}
