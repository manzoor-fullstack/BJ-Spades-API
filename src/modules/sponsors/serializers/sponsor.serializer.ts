import type { Sponsor, SponsorStatus } from '@prisma/client';

import { formatMoney } from '../../../common/money/money.util';

/** One row of the Sponsors tab. */
export interface SponsorListItem {
  id: string;
  name: string;
  prizeDescription: string;
  /** Two-decimal string. */
  value: string;
  /**
   * How the arrangement works — "10% affiliate", "Promo codes". Free text:
   * these are commercial terms, not a set the software should enumerate.
   */
  splitType: string;
  contactEmail: string;
  status: SponsorStatus;
  createdAt: Date;
  updatedAt: Date;
}

export function toSponsorListItem(sponsor: Sponsor): SponsorListItem {
  return {
    id: sponsor.id,
    name: sponsor.name,
    prizeDescription: sponsor.prizeDescription,
    value: formatMoney(sponsor.value),
    splitType: sponsor.splitType,
    contactEmail: sponsor.contactEmail,
    status: sponsor.status,
    createdAt: sponsor.createdAt,
    updatedAt: sponsor.updatedAt,
  };
}
