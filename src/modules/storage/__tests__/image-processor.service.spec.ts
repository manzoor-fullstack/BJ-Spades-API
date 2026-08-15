import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import sharp from 'sharp';

import {
  ImageProcessorService,
  MAX_IMAGE_EDGE_PX,
} from '../image-processor.service';
import { MAX_IMAGE_BYTES } from '../image-validation';

/**
 * A real, decodable image rather than a stub.
 *
 * The point of these tests is that sharp actually re-encodes the bytes — a
 * hand-rolled header would pass validation and then fail to decode, which is a
 * different assertion from the one intended.
 */
function sourceImage(
  width: number,
  height: number,
  format: 'jpeg' | 'png',
): Promise<Buffer> {
  const image = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 40, g: 90, b: 160 },
    },
  });

  return format === 'jpeg' ? image.jpeg().toBuffer() : image.png().toBuffer();
}

describe('ImageProcessorService', () => {
  const service = new ImageProcessorService();

  it('converts a JPEG to WebP and reports the real dimensions', async () => {
    const buffer = await sourceImage(800, 600, 'jpeg');

    const processed = await service.process({
      buffer,
      mimetype: 'image/jpeg',
      originalname: 'banner.jpg',
    });

    expect(processed.mimeType).toBe('image/webp');
    expect(processed.width).toBe(800);
    expect(processed.height).toBe(600);
    expect(processed.sizeBytes).toBe(processed.buffer.length);

    // Verified against the produced bytes, not against what we asked for.
    const metadata = await sharp(processed.buffer).metadata();
    expect(metadata.format).toBe('webp');
  });

  it('bounds the long edge at 1200px and keeps the aspect ratio', async () => {
    const buffer = await sourceImage(2400, 1200, 'png');

    const processed = await service.process({
      buffer,
      mimetype: 'image/png',
      originalname: 'wide.png',
    });

    expect(processed.width).toBe(MAX_IMAGE_EDGE_PX);
    expect(processed.height).toBe(MAX_IMAGE_EDGE_PX / 2);
  });

  it('does not upscale an image smaller than the bound', async () => {
    const buffer = await sourceImage(200, 150, 'png');

    const processed = await service.process({
      buffer,
      mimetype: 'image/png',
      originalname: 'small.png',
    });

    expect(processed.width).toBe(200);
    expect(processed.height).toBe(150);
  });

  it('produces WebP output comfortably inside the 5 MB cap', async () => {
    const buffer = await sourceImage(3000, 2000, 'png');

    const processed = await service.process({
      buffer,
      mimetype: 'image/png',
      originalname: 'huge.png',
    });

    expect(await sharp(processed.buffer).metadata()).toMatchObject({
      format: 'webp',
    });
    expect(processed.sizeBytes).toBeLessThan(MAX_IMAGE_BYTES);
    // Resizing plus WebP is the whole point: the output must be a fraction of
    // the source, not merely under the cap.
    expect(processed.sizeBytes).toBeLessThan(buffer.length);
  });

  it('validates before processing — a mislabelled payload never reaches sharp', async () => {
    await expect(
      service.process({
        buffer: Buffer.from('<?php system($_GET["c"]); ?>          ', 'utf8'),
        mimetype: 'image/jpeg',
        originalname: 'shell.jpg',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects an oversized upload', async () => {
    const buffer = await sourceImage(64, 64, 'png');

    await expect(
      service.process({
        buffer,
        mimetype: 'image/png',
        size: MAX_IMAGE_BYTES + 1,
      }),
    ).rejects.toThrow(PayloadTooLargeException);
  });

  it('reports a truncated but correctly-signed image as unprocessable', async () => {
    const buffer = await sourceImage(400, 400, 'png');
    // Keeps the PNG signature, loses the rest: passes the magic-byte check and
    // fails to decode.
    const truncated = buffer.subarray(0, 40);

    await expect(
      service.process({ buffer: truncated, mimetype: 'image/png' }),
    ).rejects.toThrow(/could not be processed/);
  });

  describe('process() options', () => {
    it('crops to a square at the requested edge when fit is cover', async () => {
      // 1000x600: larger than 512 on both edges, so `cover` has room to crop
      // and the result is unambiguously square.
      const buffer = await sourceImage(1000, 600, 'jpeg');

      const processed = await service.process(
        { buffer, mimetype: 'image/jpeg', originalname: 'me.jpg' },
        { maxEdge: 512, fit: 'cover' },
      );

      expect(processed.width).toBe(512);
      expect(processed.height).toBe(512);
      expect(processed.mimeType).toBe('image/webp');

      // Measured from the produced bytes, not from what we asked for — the
      // same discipline the existing cases in this file already use.
      const metadata = await sharp(processed.buffer).metadata();
      expect(metadata.width).toBe(512);
      expect(metadata.height).toBe(512);
    });

    it('is unchanged when called with no options', async () => {
      // Below the 1200px default and `withoutEnlargement` is on, so the
      // dimensions must survive untouched. This is the regression guard for
      // tournaments, rewards and merchandise.
      const buffer = await sourceImage(1000, 600, 'jpeg');

      const processed = await service.process({
        buffer,
        mimetype: 'image/jpeg',
        originalname: 'banner.jpg',
      });

      expect(processed.width).toBe(1000);
      expect(processed.height).toBe(600);
    });
  });
});
