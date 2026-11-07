import { db, schema } from '@landscape/core';
import { eq } from 'drizzle-orm';
export async function isBackdatedEntryEnabled(executor: Pick<typeof db, 'select'> = db) {
  const [row] = await executor.select().from(schema.appFeatures)
    .where(eq(schema.appFeatures.key, 'backdatedEntry')).limit(1);
  return row?.enabled === true;
}
