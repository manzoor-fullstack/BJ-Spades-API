import type { Request } from 'express';

import { extractIpAddress } from '../http/request-context.util';

function fakeRequest(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  } as Request;
}

describe('extractIpAddress', () => {
  it('uses the IP Express resolved through its trust-proxy policy', () => {
    expect(extractIpAddress(fakeRequest({ ip: '203.0.113.12' }))).toBe(
      '203.0.113.12',
    );
  });

  it('does not trust a raw x-forwarded-for header itself', () => {
    expect(
      extractIpAddress(
        fakeRequest({
          headers: { 'x-forwarded-for': '198.51.100.99' },
          ip: '127.0.0.1',
        }),
      ),
    ).toBe('127.0.0.1');
  });
});
