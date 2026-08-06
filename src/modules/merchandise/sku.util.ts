/**
 * SKU generation for merchandise variants (docs/phases/PHASE-5.md, 5.14).
 *
 * `MerchandiseVariant.sku` is optional but globally `@unique`. When the admin
 * does not supply one it is generated here rather than left null, so every
 * variant has a stable handle a warehouse or a spreadsheet can refer to.
 */

/** Shared by every generated SKU, so they are greppable in any export. */
export const SKU_PREFIX = 'MERCH';

/** Guards the disambiguation loop; a product cannot have this many variants. */
const MAX_SUFFIX_ATTEMPTS = 1000;

/** Uppercase alphanumerics only — a SKU ends up in URLs, CSVs and barcodes. */
function slug(part: string): string {
  return part
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');
}

/**
 * `MERCH-{first 4 of the product id}-{SIZE}-{COLOR}` — e.g. `MERCH-A3F2-L-BLACK`.
 *
 * Deterministic: the same product, size and colour always produce the same
 * string, which is what makes a re-run of a seed or an import idempotent rather
 * than a source of duplicates.
 *
 * Size and colour are both optional on the model, so a segment is omitted when
 * its value is absent. That leaves one case — a variant with neither — where two
 * variants of the same product would collide; `disambiguateSku` below settles
 * it, because the alternative is a 500 from a unique-constraint violation the
 * admin cannot act on.
 */
export function generateSku(
  merchandiseId: string,
  size: string | null | undefined,
  color: string | null | undefined,
): string {
  const idPart = merchandiseId
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 4)
    .toUpperCase();

  const segments = [SKU_PREFIX, idPart];

  const sizePart = size ? slug(size) : '';
  const colorPart = color ? slug(color) : '';

  if (sizePart) {
    segments.push(sizePart);
  }

  if (colorPart) {
    segments.push(colorPart);
  }

  return segments.join('-');
}

/**
 * Returns `base`, or `base-2`, `base-3`, … until one is not already taken.
 *
 * `taken` holds both the SKUs already in the database for this product and the
 * ones generated earlier in the same request — a batch of three identical
 * variants must not produce three identical SKUs and then fail on the second
 * insert.
 */
export function disambiguateSku(
  base: string,
  taken: ReadonlySet<string>,
): string {
  if (!taken.has(base)) {
    return base;
  }

  for (let suffix = 2; suffix < MAX_SUFFIX_ATTEMPTS; suffix += 1) {
    const candidate = `${base}-${suffix}`;

    if (!taken.has(candidate)) {
      return candidate;
    }
  }

  // Unreachable for any realistic variant count; throwing beats returning a
  // value that is about to violate a unique constraint.
  throw new Error(`Could not generate a unique SKU from "${base}".`);
}
