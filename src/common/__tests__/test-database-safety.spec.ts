import { assertTestDatabaseUrl } from '../../../test/test-database-safety';

describe('destructive test database boundary', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])(
    'accepts the dedicated local test database on %s',
    (host) => {
      const url = `postgresql://postgres:postgres@${host}:5434/bjspades_test?schema=public`;
      expect(assertTestDatabaseUrl(url)).toBe(url);
    },
  );

  it.each([
    undefined,
    '',
    'invalid',
    'https://localhost:5434/bjspades_test',
    'postgresql://localhost:5432/bjspades_test',
    'postgresql://localhost/bjspades_test',
    'postgresql://production.example:5434/bjspades_test',
    'postgresql://bjspades_test:secret@localhost:5434/production',
    'postgresql://localhost:5434/production?application_name=bjspades_test',
    'postgresql://localhost:5434/bjspades_test_backup',
    'postgresql://localhost:5434/bjspades_test?schema=private',
    'postgresql://localhost:5434/bjspades_test?host=production.example',
    'postgresql://localhost:5434/bjspades_test?options=-csearch_path=private',
  ])('rejects an unsafe database URL without disclosing it', (url) => {
    expect(() => assertTestDatabaseUrl(url)).toThrow(
      'Refusing destructive tests:',
    );
    try {
      assertTestDatabaseUrl(url);
    } catch (error) {
      expect(String(error)).not.toContain('secret');
    }
  });
});
