import { sql } from 'drizzle-orm';
import { closeDb, db } from '../db/client.js';

// One-off cleanup for the review queue: Gmail receipts whose stored extraction already
// says isReceipt=false were left pending because the pipeline used to ignore that
// verdict. Dry-run by default; pass --apply to dismiss them (status n/a, reversible
// from the receipts n/a filter).

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const candidates = await db.execute(sql`
    SELECT id, file_name, merchant, created_at, ocr_json->>'notes' AS notes
    FROM receipts
    WHERE source = 'gmail'
      AND status = 'pending'
      AND transaction_id IS NULL
      AND ocr_json->>'isReceipt' = 'false'
    ORDER BY created_at DESC
  `);

  console.log(`Pending Gmail receipts the extractor marked as non-receipts: ${candidates.rows.length}`);
  console.table(candidates.rows.map((row) => ({
    id: row.id,
    file: row.file_name,
    merchant: row.merchant,
    notes: typeof row.notes === 'string' ? row.notes.slice(0, 80) : row.notes,
  })));

  if (!apply) {
    console.log('Dry run — re-run with --apply to dismiss these receipts.');
    return;
  }

  const dismissed = await db.execute(sql`
    UPDATE receipts
    SET status = 'n/a', updated_at = now()
    WHERE source = 'gmail'
      AND status = 'pending'
      AND transaction_id IS NULL
      AND ocr_json->>'isReceipt' = 'false'
    RETURNING id
  `);
  await db.execute(sql`
    UPDATE receipt_matches
    SET status = 'rejected', decided_at = now()
    WHERE status IN ('suggested', 'auto')
      AND receipt_id IN (SELECT id FROM receipts WHERE status = 'n/a' AND source = 'gmail' AND ocr_json->>'isReceipt' = 'false')
  `);
  console.log(`Dismissed ${dismissed.rows.length} receipts.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDb();
  });
