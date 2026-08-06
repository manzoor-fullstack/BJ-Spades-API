import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

import {
  assertValidImage,
  detectImageMimeType,
  isAllowedImageMimeType,
  MAX_IMAGE_BYTES,
  type ValidatableUpload,
} from '../image-validation';

/** Minimal headers, padded past the 12-byte window the detector needs. */
function jpegBytes(payload = ''): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from(`0000JFIF${payload}`, 'ascii'),
  ]);
}

function pngBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  ]);
}

function webpBytes(): Buffer {
  return Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from('WEBPVP8 ', 'ascii'),
  ]);
}

function upload(overrides: Partial<ValidatableUpload> = {}): ValidatableUpload {
  return {
    buffer: jpegBytes(),
    mimetype: 'image/jpeg',
    originalname: 'banner.jpg',
    ...overrides,
  };
}

describe('detectImageMimeType', () => {
  it('identifies JPEG, PNG and WebP by their headers', () => {
    expect(detectImageMimeType(jpegBytes())).toBe('image/jpeg');
    expect(detectImageMimeType(pngBytes())).toBe('image/png');
    expect(detectImageMimeType(webpBytes())).toBe('image/webp');
  });

  it('does not mistake other RIFF containers for WebP', () => {
    // A WAV file is also RIFF; only the form type at bytes 8..11 tells them
    // apart, which is why checking "RIFF" alone would be wrong.
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WAVEfmt ', 'ascii'),
    ]);

    expect(detectImageMimeType(wav)).toBeNull();
  });

  it('returns null for a buffer too short to identify', () => {
    expect(detectImageMimeType(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });

  it('returns null for arbitrary content', () => {
    expect(
      detectImageMimeType(Buffer.from('<?php system($_GET["c"]); ?>', 'utf8')),
    ).toBeNull();
  });
});

describe('isAllowedImageMimeType', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp'])('allows %s', (mime) => {
    expect(isAllowedImageMimeType(mime)).toBe(true);
  });

  it.each(['image/gif', 'image/svg+xml', 'application/x-php', 'text/html'])(
    'rejects %s',
    (mime) => {
      expect(isAllowedImageMimeType(mime)).toBe(false);
    },
  );
});

describe('assertValidImage', () => {
  it('accepts a well-formed JPEG', () => {
    expect(assertValidImage(upload())).toBe('image/jpeg');
  });

  it('rejects a file over 5 MB before looking at its contents', () => {
    expect(() =>
      assertValidImage(upload({ size: MAX_IMAGE_BYTES + 1 })),
    ).toThrow(PayloadTooLargeException);
  });

  it('falls back to the buffer length when no size was reported', () => {
    const oversized = upload({
      buffer: Buffer.alloc(MAX_IMAGE_BYTES + 1),
      size: undefined,
    });

    expect(() => assertValidImage(oversized)).toThrow(PayloadTooLargeException);
  });

  it('accepts a file exactly on the limit', () => {
    expect(assertValidImage(upload({ size: MAX_IMAGE_BYTES }))).toBe(
      'image/jpeg',
    );
  });

  it('rejects a declared MIME type outside the allowlist', () => {
    expect(() => assertValidImage(upload({ mimetype: 'image/gif' }))).toThrow(
      BadRequestException,
    );
  });

  it('rejects a PHP payload renamed to .jpg', () => {
    // The classic upload bypass: an image extension and an image Content-Type
    // on a file whose first bytes are a script. Only the magic-byte check sees
    // through it.
    const payload = upload({
      buffer: Buffer.from(
        '<?php echo shell_exec($_GET["cmd"]); ?>                ',
        'utf8',
      ),
      mimetype: 'image/jpeg',
      originalname: 'shell.jpg',
    });

    expect(() => assertValidImage(payload)).toThrow(BadRequestException);
    expect(() => assertValidImage(payload)).toThrow(
      /not a recognised JPEG, PNG or WebP image/,
    );
  });

  it('rejects a real PNG declared as JPEG', () => {
    expect(() =>
      assertValidImage(upload({ buffer: pngBytes(), mimetype: 'image/jpeg' })),
    ).toThrow(/content is image\/png but was declared as image\/jpeg/);
  });
});
