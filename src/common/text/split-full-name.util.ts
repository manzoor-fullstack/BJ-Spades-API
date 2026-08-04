export interface SplitName {
  firstName: string;
  lastName: string;
}

/**
 * Splits a single "full name" field into the two columns the User model keeps.
 *
 * Both the admin create-user modal and the registration webhook collect one
 * name field, while the database stores first and last separately so admins can
 * sort and search by surname.
 *
 * Splits on the FIRST space only: "Mary Jane Watson" becomes
 * firstName "Mary", lastName "Jane Watson". A single-word name yields an empty
 * lastName, which is allowed — plenty of people have one name, and rejecting
 * them would be a bug, not a validation.
 */
export function splitFullName(fullName: string): SplitName {
  const normalised = fullName.trim().replace(/\s+/g, ' ');
  const boundary = normalised.indexOf(' ');

  if (boundary === -1) {
    return { firstName: normalised, lastName: '' };
  }

  return {
    firstName: normalised.slice(0, boundary),
    lastName: normalised.slice(boundary + 1),
  };
}

/** Recomposes a display name, tolerating an empty lastName. */
export function joinFullName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.trim();
}

/** Two-letter initials for the avatar circles used across the UI. */
export function initialsOf(firstName: string, lastName: string): string {
  const first = firstName.trim().charAt(0).toUpperCase();
  const last = lastName.trim().charAt(0).toUpperCase();

  return `${first}${last}` || '?';
}
