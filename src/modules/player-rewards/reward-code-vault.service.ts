import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RewardCodeVault {
  constructor(private readonly config: ConfigService) {}

  encrypt(value: string): string {
    const key = this.key();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), encrypted]
      .map((part) => part.toString('base64url'))
      .join('.');
  }

  decrypt(value: string): string {
    const key = this.key();
    const [ivValue, tagValue, encryptedValue] = value.split('.');
    if (!ivValue || !tagValue || !encryptedValue) {
      throw new ServiceUnavailableException('Stored reward code is invalid.');
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(ivValue, 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(encryptedValue, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new ServiceUnavailableException(
        'Stored reward code cannot be opened.',
      );
    }
  }

  private key(): Buffer {
    const encoded = this.config.get<string>('REWARD_CODE_ENCRYPTION_KEY') ?? '';
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32) {
      throw new ServiceUnavailableException(
        'Reward code fulfilment is not configured.',
      );
    }
    return key;
  }
}
