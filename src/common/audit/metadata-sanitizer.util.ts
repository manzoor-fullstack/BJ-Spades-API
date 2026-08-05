export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * Keys never written to `ActivityLog.metadata`, matched case-insensitively at
 * every depth.
 *
 * The audit log is readable by anyone holding `activity.view`. A create-admin
 * body carries a plaintext password and a refresh call carries a token, so the
 * default metadata source — the request body — is exactly where secrets would
 * otherwise land. See docs/phases/PHASE-2.md, "Metadata diffs".
 */
export const SENSITIVE_METADATA_KEYS: readonly string[] = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'refreshToken',
  'tokenHash',
  'secret',
  'signature',
  'authorization',
];

const DENIED = new Set(SENSITIVE_METADATA_KEYS.map((key) => key.toLowerCase()));

/**
 * Depth ceiling. A pathological payload nested thousands deep would otherwise
 * blow the stack inside an audit write — the one place that must never take a
 * request down with it.
 */
const MAX_DEPTH = 8;

/** True when a key must never reach `ActivityLog.metadata`. */
export function isSensitiveKey(key: string): boolean {
  return DENIED.has(key.toLowerCase());
}

function hasToJson(value: object): value is { toJSON: () => unknown } {
  return 'toJSON' in value && typeof value.toJSON === 'function';
}

function sanitizeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): JsonValue | undefined {
  if (value === null) return null;

  switch (typeof value) {
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    case 'string':
      return value;
    case 'boolean':
      return value;
    case 'number':
      // JSON has no NaN or Infinity; JSON.stringify writes null for both.
      return Number.isFinite(value) ? value : null;
    case 'bigint':
      return value.toString();
    default:
      break;
  }

  const asObject = value;

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (depth >= MAX_DEPTH) {
    return '[truncated]';
  }

  // Cycles are silently dropped rather than thrown: an unserialisable payload
  // must not cost the caller its audit entry.
  if (seen.has(asObject)) {
    return '[circular]';
  }

  seen.add(asObject);

  try {
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeValue(item, depth + 1, seen) ?? null);
    }

    // Prisma.Decimal and similar wrappers know how to describe themselves;
    // walking their internals would store digit arrays instead of "100.00".
    if (hasToJson(asObject)) {
      return sanitizeValue(asObject.toJSON(), depth + 1, seen) ?? null;
    }

    const result: Record<string, JsonValue> = {};

    for (const [key, entry] of Object.entries(asObject)) {
      if (isSensitiveKey(key)) {
        continue;
      }

      const sanitized = sanitizeValue(entry, depth + 1, seen);

      if (sanitized !== undefined) {
        result[key] = sanitized;
      }
    }

    return result;
  } finally {
    seen.delete(asObject);
  }
}

/**
 * Returns a JSON-safe copy with every denylisted key removed, at any depth.
 *
 * `undefined` back means "nothing worth storing" — the caller omits the column
 * rather than writing an empty object.
 */
export function sanitizeMetadata(value: unknown): JsonValue | undefined {
  const sanitized = sanitizeValue(value, 0, new WeakSet<object>());

  if (sanitized === undefined) {
    return undefined;
  }

  if (
    typeof sanitized === 'object' &&
    sanitized !== null &&
    !Array.isArray(sanitized) &&
    Object.keys(sanitized).length === 0
  ) {
    return undefined;
  }

  return sanitized;
}
