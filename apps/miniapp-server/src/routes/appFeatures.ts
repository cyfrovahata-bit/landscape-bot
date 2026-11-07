import { db as productionDb, schema } from '@landscape/core';
import { asyncRouter } from '../asyncRouter.js';
import { isBackdatedEntryEnabled } from '../lib/appFeatures.js';
export function createAppFeaturesRouter(db: typeof productionDb) {
  const router = asyncRouter();
  router.get('/', async (_req, res) => {
    res.json({ backdatedEntryEnabled: await isBackdatedEntryEnabled(db) });
  });
  router.put('/backdated-entry', async (req, res) => {
    if (req.user?.role !== 'ADMIN') { res.status(403).json({error:'Лише адміністратор може змінювати налаштування.'}); return; }
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') { res.status(400).json({error:'enabled має бути boolean'}); return; }
    await db.transaction(async tx => {
      await tx.insert(schema.appFeatures).values({key:'backdatedEntry', enabled, updatedBy:BigInt(req.user!.tgId)})
        .onConflictDoUpdate({target:schema.appFeatures.key, set:{enabled, updatedBy:BigInt(req.user!.tgId), updatedAt:new Date()}});
    });
    res.json({backdatedEntryEnabled:await isBackdatedEntryEnabled(db)});
  });
  return router;
}
export const appFeaturesRouter = createAppFeaturesRouter(productionDb);
