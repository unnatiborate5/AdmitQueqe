'use strict';
const app = require('./app');

const PORT = process.env.PORT || 3000;

const queueService = require('./services/queueService');

app.listen(PORT, () => {
  console.log(`AdmitFlow is running at http://localhost:${PORT}`);
});

// stop the C++ queue engine together with the server
['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => { queueService.shutdown(); process.exit(0); }));
