export type AppEdition = 'full' | 'lite';

export interface EditionDeclaration {
  edition: AppEdition;
  label: string;
  requireCode: boolean;
  fullExpiryAt: number | null;
  liteAllowedDayStart: number;
  liteAllowedDayEnd: number;
  timeZone: string;
}

/**
 * Public product metadata, shared so the server and browser cannot silently disagree.
 * This contains no credential or authorization proof. Edition packaging changes this
 * declaration; the server remains the authority that evaluates it.
 */
export const DECLARED_EDITION: EditionDeclaration = {
  edition: 'full',
  label: '6 Tháng',
  requireCode: true,
  fullExpiryAt: 1801414740000, // 2027-01-31T23:59:00+07:00
  liteAllowedDayStart: 1,
  liteAllowedDayEnd: 3,
  timeZone: 'Asia/Ho_Chi_Minh',
};

export interface EntitlementDecision {
  edition: AppEdition;
  label: string;
  valid: boolean;
  expiresAt: number | null;
  policy: 'full-expiry' | 'lite-monthly-window';
}

const dayOfMonth = (now: number, timeZone: string): number => Number(new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  timeZone,
}).format(new Date(now)));

export const evaluateEditionEntitlement = (
  declaration: EditionDeclaration = DECLARED_EDITION,
  now = Date.now(),
): EntitlementDecision => {
  if (declaration.edition === 'lite') {
    const day = dayOfMonth(now, declaration.timeZone);
    return {
      edition: declaration.edition,
      label: declaration.label,
      valid: day >= declaration.liteAllowedDayStart && day <= declaration.liteAllowedDayEnd,
      expiresAt: null,
      policy: 'lite-monthly-window',
    };
  }
  return {
    edition: declaration.edition,
    label: declaration.label,
    valid: declaration.fullExpiryAt === null || now <= declaration.fullExpiryAt,
    expiresAt: declaration.fullExpiryAt,
    policy: 'full-expiry',
  };
};
