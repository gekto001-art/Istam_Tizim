import { createApp } from './app.js';
import { config } from './config.js';
import { checkAppRole, pool } from './db/pool.js';

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

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
