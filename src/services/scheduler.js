const cron = require('node-cron');
const db = require('../db');
const { fullSync } = require('./sync');
const config = require('../config');

let cronJob = null;

function start() {
  const intervalMinutes = config.sync.pollIntervalMinutes;
  const cronExpr = `*/${intervalMinutes} * * * *`;

  cronJob = cron.schedule(cronExpr, async () => {
    console.log('[Scheduler] Polling cycle started');
    try {
      const { rows: shops } = await db.query(
        `SELECT * FROM shops WHERE is_active = TRUE`
      );

      for (const shop of shops) {
        try {
          await fullSync(shop);
        } catch (err) {
          console.error(`[Scheduler] Sync failed for ${shop.shop_domain}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[Scheduler] Failed to fetch active shops:', err.message);
    }
    console.log('[Scheduler] Polling cycle complete');
  });

  console.log(`[Scheduler] Polling every ${intervalMinutes} min (cron: ${cronExpr})`);
}

function stop() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }
}

module.exports = { start, stop };
