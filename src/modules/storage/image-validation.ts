import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

import { ErrorCode } from '../../common/constants/error-codes';

/**
 * Server-side image validation (docs/phases/PHASE-4.md, 4.3–4.4).
 *
 * The upload modals set `accept="image/jpeg,image/png"`. That attribute is a
 * client-side hint and nothing more — it is one devtools edit away from being
 * gone, so every rule below is re-applied here.
 */

/** 5 MB. Matches the limit advertised in the modal and in the API contract. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

/** The minimum bytes needed to identify every format we accept. */
const MAGIC_BYTE_WINDOW = 12;

export function isAllowedImageMimeType(
  mimeType: string,
): mimeType is AllowedImageMimeType {
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

/**
 * Identifies a buffer by its header rather than by what the request claimed.
 *
 * A declared MIME type is attacker-controlled: `Content-Type: image/jpeg` on a
 * PHP payload costs nothing to send. The first bytes of a file are the format,
 * so this is the check that actually stops a polyglot upload.
 */
export function detectImageMimeType(
  buffer: Buffer,
): AllowedImageMimeType | null {
  if (buffer.length < MAGIC_BYTE_WINDOW) {
    return null;
  }

  // JPEG — SOI marker FF D8 followed by any marker start FF.
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG — the fixed 8-byte signature.
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  // WebP — a RIFF container whose form type (bytes 8..11) is "WEBP". Checking
  // only "RIFF" would also match WAV and AVI.
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

/** The shape `assertValidImage` needs, satisfied by any Multer memory file. */
export interface ValidatableUpload {
  buffer: Buffer;
  mimetype: string;
  size?: number;
  originalname?: string;
}

/**
 * Runs the four checks in the order PHASE-4.md specifies.
 *
 * Size is first so an oversized body is refused before any work is done on its
 * contents; the declared MIME type is cheap and narrows the field; the magic
 * bytes are the one that cannot be lied about. Re-encoding through sharp is
 * step four and lives in ImageProcessorService — it is a second line of defence
 * that discards any appended payload and strips EXIF, which can carry the GPS
 * coordinates of wherever the photo was taken.
 */
export function assertValidImage(
  file: ValidatableUpload,
): AllowedImageMimeType {
  const sizeBytes = file.size ?? file.buffer.length;

  if (sizeBytes > MAX_IMAGE_BYTES) {
    throw new PayloadTooLargeException({
      message: `Image is ${sizeBytes} bytes; the limit is ${MAX_IMAGE_BYTES} bytes (5 MB).`,
      code: ErrorCode.VALIDATION_ERROR,
    });
  }

  if (!isAllowedImageMimeType(file.mimetype)) {
    throw new BadRequestException(
      `Unsupported image type "${file.mimetype}". Allowed: ${ALLOWED_IMAGE_MIME_TYPES.join(', ')}.`,
    );
  }

  const detected = detectImageMimeType(file.buffer);

  if (detected === null) {
    throw new BadRequestException(
      'File content is not a recognised JPEG, PNG or WebP image.',
    );
  }

  if (detected !== file.mimetype) {
    throw new BadRequestException(
      `File content is ${detected} but was declared as ${file.mimetype}.`,
    );
  }

  return detected;
}
