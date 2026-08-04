/** Values a CSV cell can be built from. */
export type CsvValue = string | number | boolean | Date | null | undefined;

/**
 * Leading characters that make Excel and Sheets treat a cell as a formula.
 *
 * `+` and `-` are deliberately NOT in this set: they lead legitimate phone
 * numbers and negative amounts, and prefixing those would corrupt data that
 * every consumer of this export actually needs. `=`, `@` and the control
 * characters have no legitimate leading use in the columns we emit.
 */
const FORMULA_PREFIXES = ['=', '@', '\t', '\r'];

function stringify(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  return String(value);
}

/**
 * Quotes every cell — always, not conditionally — and doubles embedded quotes
 * per RFC 4180. Always quoting means a value that later grows a comma cannot
 * silently shift every column to its right.
 */
export function escapeCsvCell(value: CsvValue): string {
  let text = stringify(value);

  if (FORMULA_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    text = `'${text}`;
  }

  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsvRow(values: readonly CsvValue[]): string {
  return values.map(escapeCsvCell).join(',');
}
