import { createApp } from './app.js';
import { assertConfig, config } from './config.js';

try {
  assertConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const app = await createApp(config);
await app.listen({ host: config.host, port: config.port });

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Shutting down');
    // Stops accepting connections and waits for in-flight renders.
    await app.close();
    process.exit(0);
  });
}
