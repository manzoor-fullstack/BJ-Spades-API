/**
 * The compiled-in default for the point at which stock is reported as running
 * low, and the value in force before settings have been loaded.
 */
export const LOW_STOCK_THRESHOLD = 5;

/**
 * The threshold actually in force.
 *
 * Phase 7 makes this configurable through `inventory.lowStockThreshold`.
 * `SettingsService` pushes the stored value in here whenever it loads its
 * snapshot — at boot and after every save.
 *
 * Held as module state rather than injected because the only consumers are
 * `isLowStock` calls inside the reward and merchandise *serializers*, which are
 * pure functions with no container behind them. Threading a service through
 * two serializers, their services and their tests to move one integer is a
 * worse trade than one process-wide value with a single writer.
 */
let currentThreshold = LOW_STOCK_THRESHOLD;

export function setLowStockThreshold(threshold: number): void {
  currentThreshold = threshold;
}

export function getLowStockThreshold(): number {
  return currentThreshold;
}

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
  return stock !== null && stock > 0 && stock <= currentThreshold;
}
