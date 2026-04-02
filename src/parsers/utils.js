import { createHash } from 'crypto';

/**
 * Generate a stable imported_id for deduplication.
 * Uses SHA-256 of bank + date + amount + description + row index.
 * Row index disambiguates identical transactions on the same day.
 */
export function generateImportedId(bank, date, amountCents, rawDescription, rowIndex) {
  const input = `${bank}|${date}|${amountCents}|${rawDescription}|${rowIndex}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}
