import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { RewardCodeVault } from '../reward-code-vault.service';

describe('RewardCodeVault', () => {
  it('round-trips a bearer code without storing it in plaintext', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const config = {
      get: jest.fn().mockReturnValue(key),
    } as unknown as ConfigService;
    const vault = new RewardCodeVault(config);

    const encrypted = vault.encrypt('REAL-CODE-1234');

    expect(encrypted).not.toContain('REAL-CODE-1234');
    expect(vault.decrypt(encrypted)).toBe('REAL-CODE-1234');
  });

  it('fails closed when the encryption key is missing or malformed', () => {
    const config = {
      get: jest.fn().mockReturnValue(''),
    } as unknown as ConfigService;
    const vault = new RewardCodeVault(config);

    expect(() => vault.encrypt('CODE')).toThrow(ServiceUnavailableException);
  });
});
