/**
 * Signs and sends a real user-registration webhook.
 *
 *   pnpm run webhook:test -- --email david.kim@email.com --name "David Kim"
 *
 * The point of this script is that it is a genuine HTTP client, not a test
 * double: it exercises raw-body capture, the signature check and the database
 * write exactly as the external signup form will. Reproducing the same failure
 * from a spec file proves much less.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import * as dotenv from 'dotenv';

const TIER_VALUES = ['PLAYER', 'PREMIUM', 'VIP'] as const;
type Tier = (typeof TIER_VALUES)[number];

interface Options {
  url: string;
  secret: string;
  email: string;
  name: string;
  mobileNumber?: string;
  tier: Tier;
  eventId: string;
  source: string;
  /** Deliberately break the request, to check the 401 paths by hand. */
  tamper: boolean;
  staleTimestamp: boolean;
}

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === undefined || !token.startsWith('--')) continue;

    const [name, inlineValue] = token.slice(2).split('=', 2);

    if (name === undefined || name.length === 0) continue;

    if (inlineValue !== undefined) {
      flags.set(name, inlineValue);
      continue;
    }

    const next = argv[index + 1];

    // `--tamper` with no value is a boolean switch.
    if (next === undefined || next.startsWith('--')) {
      flags.set(name, 'true');
      continue;
    }

    flags.set(name, next);
    index += 1;
  }

  return flags;
}

function loadEnv(): void {
  const candidates = ['.env', '.env.test'].map((file) =>
    resolve(__dirname, '..', file),
  );

  for (const path of candidates) {
    if (existsSync(path)) {
      dotenv.config({ path });
      return;
    }
  }
}

function resolveOptions(flags: Map<string, string>): Options {
  const secret = flags.get('secret') ?? process.env.WEBHOOK_SECRET;

  if (!secret) {
    throw new Error(
      'No signing secret. Set WEBHOOK_SECRET in .env or pass --secret.',
    );
  }

  const baseUrl =
    flags.get('url') ?? process.env.PUBLIC_URL ?? 'http://localhost:5000';

  const tierFlag = (flags.get('tier') ?? 'PLAYER').toUpperCase();

  if (!TIER_VALUES.includes(tierFlag as Tier)) {
    throw new Error(`--tier must be one of ${TIER_VALUES.join(', ')}.`);
  }

  return {
    url: baseUrl.endsWith('/webhooks/user-registration')
      ? baseUrl
      : `${baseUrl.replace(/\/$/, '')}/api/webhooks/user-registration`,
    secret,
    email: flags.get('email') ?? `webhook.${Date.now()}@example.com`,
    name: flags.get('name') ?? 'Webhook Tester',
    mobileNumber: flags.get('mobile'),
    tier: tierFlag as Tier,
    eventId: flags.get('event-id') ?? `evt_${randomUUID()}`,
    source: flags.get('source') ?? 'bjspades-signup-form',
    tamper: flags.get('tamper') === 'true',
    staleTimestamp: flags.get('stale') === 'true',
  };
}

async function main(): Promise<void> {
  loadEnv();

  const options = resolveOptions(parseFlags(process.argv.slice(2)));

  const payload = {
    event: 'user.registration',
    data: {
      fullName: options.name,
      email: options.email,
      ...(options.mobileNumber ? { mobileNumber: options.mobileNumber } : {}),
      tier: options.tier,
    },
  };

  // Stringified ONCE. The single most common integration failure is signing
  // one string and sending another; calling JSON.stringify twice is exactly
  // how that happens.
  const rawBody = JSON.stringify(payload);

  const timestamp = options.staleTimestamp
    ? Math.floor(Date.now() / 1000) - 600
    : Math.floor(Date.now() / 1000);

  const signature = createHmac('sha256', options.secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  // Tampering after signing, so the signature is valid for a different body.
  const bodyToSend = options.tamper
    ? rawBody.replace(/"fullName":"[^"]*"/, '"fullName":"Tampered Name"')
    : rawBody;

  console.log(`POST ${options.url}`);
  console.log(`  event id : ${options.eventId}`);
  console.log(`  email    : ${options.email}`);
  console.log(`  body     : ${bodyToSend}`);

  const response = await fetch(options.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-BJS-Signature': `sha256=${signature}`,
      'X-BJS-Timestamp': String(timestamp),
      'X-BJS-Event-Id': options.eventId,
      'X-BJS-Source': options.source,
    },
    body: bodyToSend,
  });

  const text = await response.text();

  console.log(`\n${response.status} ${response.statusText}`);
  console.log(text);

  // Non-zero on anything but a 2xx, so CI and shell chaining can rely on it.
  if (!response.ok) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
