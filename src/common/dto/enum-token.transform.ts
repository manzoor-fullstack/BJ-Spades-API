import type { TransformFnParams } from 'class-transformer';

/**
 * The value as it arrived, before class-transformer touched it.
 *
 * `enableImplicitConversion` is on globally (see main.ts), and it runs BEFORE
 * `@Transform`. By the time a transformer is called, `params.value` for a
 * `number` property has already been through `Number(...)` — so an empty
 * multipart field arrives as `0`, and `"false"` on a `boolean` property arrives
 * as `true`. Both are unrecoverable from the converted value, which is why every
 * transformer here reads the original off `params.obj` instead.
 */
function rawValue(params: TransformFnParams): unknown {
  return (params.obj as Record<string, unknown>)[params.key];
}

/**
 * Normalises an inbound enum token to the Prisma spelling.
 *
 * The create modals submit their select values in the shape the mock data used:
 * `"food"`, `"coming-soon"`. The database enums are `FOOD` and `COMING_SOON`.
 * Rejecting the modal's own values would be technically defensible and
 * practically useless, so the token is upper-cased and its separators
 * normalised before `@IsEnum` sees it.
 *
 * Anything that is not a recognised member still fails validation — this widens
 * the accepted spellings, not the accepted set.
 */
export function toEnumToken(params: TransformFnParams): unknown {
  const raw = rawValue(params);

  if (typeof raw !== 'string') {
    return params.value;
  }

  const trimmed = raw.trim();

  if (trimmed === '') {
    // Multipart forms send an empty string for a control the user never
    // touched. Treated as "not supplied" so it does not fail as an invalid
    // enum member.
    return undefined;
  }

  return trimmed.toUpperCase().replace(/[-\s]+/g, '_');
}

/**
 * Maps the empty string a multipart form sends for an untouched field to
 * `undefined`, so an optional numeric field is not silently read as `0`.
 */
export function emptyStringToUndefined(params: TransformFnParams): unknown {
  const raw = rawValue(params);

  return typeof raw === 'string' && raw.trim() === ''
    ? undefined
    : params.value;
}

/**
 * Reads a query-string boolean.
 *
 * Query strings carry `"true"` and `"false"`, both of which implicit conversion
 * turns into `true` — which would make `?includeDeleted=false` return the
 * deleted rows. Parsed from the raw string for exactly that reason.
 */
export function toBooleanFlag(params: TransformFnParams): unknown {
  const raw = rawValue(params);

  if (typeof raw === 'string') {
    const normalised = raw.trim().toLowerCase();

    if (normalised === 'true') return true;
    if (normalised === 'false') return false;
    if (normalised === '') return undefined;
  }

  return params.value;
}
