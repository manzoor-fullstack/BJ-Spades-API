/**
 * The compiled-in point at which stock is reported as running low. Not
 * configurable — there is no setting that overrides it.
 */
export const LOW_STOCK_THRESHOLD = 5;

/**
 * Zero is *out of stock*, which the UI shows differently from *low stock*
 * (docs/phases/PHASE-5.md, G5). Folding the two together would hide the
 * difference between "order more soon" and "nobody can have this".
 *
 * Stock is NEVER decremented in Milestone 1 — there is no redemption or
 * ordering flow, so the only thing that moves a stock number is an admin
 * editing it (docs/phases/PHASE-5.md, "Stock").
 */
export function isLowStock(stock: number | null): boolean {
  return stock !== null && stock > 0 && stock <= LOW_STOCK_THRESHOLD;
}
