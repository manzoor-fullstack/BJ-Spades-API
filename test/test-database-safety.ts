/** Only the disposable database defined in docker-compose.test.yml is writable. */
export function assertTestDatabaseUrl(value: string | undefined): string {
  const refused =
    'Refusing destructive tests: expected PostgreSQL on localhost:5434/bjspades_test.';

  if (!value) throw new Error(refused);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(refused);
  }

  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.port !== '5434' ||
    url.pathname !== '/bjspades_test' ||
    [...url.searchParams].some(
      ([key, setting]) => key !== 'schema' || setting !== 'public',
    )
  ) {
    // Do not echo the URL: it may contain database credentials.
    throw new Error(refused);
  }

  return value;
}
