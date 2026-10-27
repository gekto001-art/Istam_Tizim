import { createApp } from './app.js';
import { config } from './config.js';
import { checkAppRole, pool } from './db/pool.js';
import { startBillzScheduler } from './services/billz.js';

const role = await checkAppRole();
if (role.superuser) {
  const msg = `Ilova "${role.user}" (superuser) bilan ulangan. APP_DATABASE_URL ni istam_app kabi oddiy rolga sozlang.`;
  if (config.isProd) {
    console.error(msg);
    process.exit(1);
  }
  console.warn('OGOHLANTIRISH: ' + msg);
}

const server = createApp().listen(config.port, () => {
  console.log(`API ishga tushdi: http://localhost:${config.port}`);
});

// Billz'dan qoldiq va sotuvni har 5 daqiqada olish (sozlamalarda yoqilgan bo'lsa); BILLZ_SYNC=off — o'chirish
const billzTimer = process.env.BILLZ_SYNC === 'off' ? null : startBillzScheduler();

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (billzTimer) clearInterval(billzTimer);
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
