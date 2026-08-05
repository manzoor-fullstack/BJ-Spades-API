import {
  isSensitiveKey,
  sanitizeMetadata,
  type JsonValue,
} from './metadata-sanitizer.util';

export interface FieldChange {
  from: JsonValue | null;
  to: JsonValue | null;
}

export type FieldChanges = Record<string, FieldChange>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function equal(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Before/after diff for the `metadata.changes` payload:
 *
 *   { "status": { "from": "ACTIVE", "to": "SUSPENDED" } }
 *
 * Only keys present in `after` are considered, and only those whose value
 * actually moved are recorded. An update that submits ten fields and changes
 * one must log one — a full snapshot buries the change and doubles the row.
 *
 * Values run through the metadata sanitizer, so a diff can never smuggle a
 * password past the denylist.
 */
export function computeDiff(before: unknown, after: unknown): FieldChanges {
  if (!isPlainRecord(after)) {
    return {};
  }

  const previous = isPlainRecord(before) ? before : {};
  const changes: FieldChanges = {};

  for (const [key, nextValue] of Object.entries(after)) {
    // A changed password is still a password: the denylist applies to the diff
    // as much as to the raw payload.
    if (nextValue === undefined || isSensitiveKey(key)) {
      continue;
    }

    const from = sanitizeMetadata(previous[key]);
    const to = sanitizeMetadata(nextValue);

    if (equal(from, to)) {
      continue;
    }

    // `sanitizeMetadata` returns undefined for a denied or unstorable value;
    // recording it as null keeps the shape uniform for the frontend.
    changes[key] = { from: from ?? null, to: to ?? null };
  }

  return changes;
}
