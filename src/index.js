// Entry point — Lay v2. All wiring lives in src/app.js; this file only starts it and handles signals.
const { createApp } = require('./app');

const instance = createApp();
instance.start().then(() => {
    const shutdown = (sig) => { console.log(JSON.stringify({ event: 'app.stopping', sig })); instance.stop().finally(() => process.exit(0)); };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}).catch((err) => {
    console.error('app failed to start', err);
    process.exit(1);
});
