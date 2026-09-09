# Disposable integration database

The integration harness migrates, seeds and truncates data. Both global setup
and the Prisma test connection enforce a parsed URL allowlist before connecting:
PostgreSQL, localhost/127.0.0.1/::1, port 5434, database `bjspades_test`, and no
query overrides except `schema=public`. A database name embedded in a password,
query or longer name is rejected. Rejections do not print credentials.

The existing `.env.test` supplies the dedicated test configuration and blank
external provider credentials. Do not replace it with a development `.env`.

Normal Docker setup uses the repository's `pnpm run db:up`. CI uses its existing
PostgreSQL service mapping 5434 to 5432. To verify just the foundation:

```powershell
pnpm exec jest --runInBand --runTestsByPath src/common/__tests__/test-database-safety.spec.ts
pnpm exec jest --config test/jest-integration.json --runInBand --runTestsByPath test/phase-0-harness.integration.spec.ts
```

On this Windows workspace, Docker was unavailable. F00 created a separate native
PostgreSQL 18 cluster under `.tmp/pg-test`, listening only on 127.0.0.1:5434, with
the database `bjspades_test`. The pre-existing port-5432 database was untouched.
The cluster is ignored by Git. It uses local trust authentication solely for this
disposable loopback test instance; never expose it on a network interface.

To restart this already initialized cluster from the API directory:

```powershell
& 'C:/Program Files/PostgreSQL/18/bin/pg_ctl.exe' -D 'D:/BJ-Spades-Admin/BJ-Spades-API/.tmp/pg-test' -l 'D:/BJ-Spades-Admin/BJ-Spades-API/.tmp/pg-test/server.log' -o '-p 5434 -h 127.0.0.1' -w start
```

Stop only this instance with the same `-D` path and `-m fast -w stop`. Do not
reinitialize, delete or point this command at an existing development cluster.
Local PostgreSQL 18 evidence is not a claim that PostgreSQL 16 CI was executed.
