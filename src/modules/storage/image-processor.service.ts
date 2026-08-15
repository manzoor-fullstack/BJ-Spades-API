import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';

import { assertValidImage, type ValidatableUpload } from './image-validation';

/**
 * Longest edge kept after resizing (docs/phases/PHASE-4.md, 4.5).
 *
 * A page of tournament cards showing untouched 4 MB phone photos downloads tens
 * of megabytes; at 1200px/WebP-82 the same photo lands around 120 KB.
 */
export const MAX_IMAGE_EDGE_PX = 1200;

/** WebP quality. 82 is the usual sweet spot before artefacts become visible. */
export const WEBP_QUALITY = 82;

export const PROCESSED_IMAGE_MIME_TYPE = 'image/webp';
export const PROCESSED_IMAGE_EXTENSION = 'webp';

export interface ProcessedImage {
  buffer: Buffer;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
}

/**
 * Per-call overrides for the resize step.
 *
 * Defaults reproduce the banner behaviour exactly, so every existing caller
 * that passes one argument is unaffected. Avatars pass
 * `{ maxEdge: 512, fit: 'cover' }`: a profile picture is displayed in a circle
 * a few dozen pixels across, and `inside` would keep whatever aspect ratio the
 * original had.
 */
export interface ProcessImageOptions {
  maxEdge?: number;
  fit?: 'inside' | 'cover';
}

@Injectable()
export class ImageProcessorService {
  private readonly logger = new Logger(ImageProcessorService.name);

  /**
   * Validates then re-encodes an upload to WebP.
   *
   * Re-encoding is not only about bandwidth. Decoding to a raw pixel buffer and
   * writing a fresh file discards everything that was not image data: an
   * appended script in a polyglot file, and EXIF metadata that routinely
   * carries GPS coordinates. The width/height/size reported back are measured
   * from the produced file, never taken from what the client claimed.
   */
  async process(
    file: ValidatableUpload,
    options: ProcessImageOptions = {},
  ): Promise<ProcessedImage> {
    assertValidImage(file);

    const maxEdge = options.maxEdge ?? MAX_IMAGE_EDGE_PX;
    const fit = options.fit ?? 'inside';

    try {
      const { data, info } = await sharp(file.buffer, { failOn: 'error' })
        // Applies the EXIF orientation flag before that metadata is dropped.
        // Skip it and portrait phone photos come out sideways.
        .rotate()
        .resize({
          width: maxEdge,
          height: maxEdge,
          fit,
          withoutEnlargement: true,
        })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer({ resolveWithObject: true });

      return {
        buffer: data,
        mimeType: PROCESSED_IMAGE_MIME_TYPE,
        sizeBytes: info.size,
        width: info.width,
        height: info.height,
      };
    } catch (error) {
      // A file that passed the magic-byte check but cannot be decoded is
      // truncated or deliberately malformed. Log the detail, tell the client
      // only that the image is unreadable.
      this.logger.warn(
        `Image processing failed: ${error instanceof Error ? error.message : String(error)}`,
      );

      throw new BadRequestException(
        'The image could not be processed. It may be corrupt or truncated.',
      );
    }
  }
}
