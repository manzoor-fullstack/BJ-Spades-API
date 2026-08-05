/**
 * What `GET /permissions` returns.
 *
 * Ids and timestamps are left out on purpose: the frontend keys everything off
 * `code`, which is the contract shared with the seed and with
 * `PUT /roles/:id/permissions`. Serving labels from here is what lets the
 * permissions modal drop its hardcoded `permissionItems` array — adding a
 * permission then needs no frontend change (docs/phases/PHASE-3.md, 3.19).
 */
export interface PermissionItem {
  code: string;
  name: string;
  description: string | null;
}
