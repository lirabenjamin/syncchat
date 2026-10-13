'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig, ConfigError } = require('./config');
const { createStorage } = require('./storage');
const { createApp } = require('./app');

const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

async function main() {
  const args = process.argv.slice(2);
  const validateOnly = args.includes('--validate');
  const files = args.filter((a) => a !== '--validate');
  const configFiles = files.length ? files : [process.env.STUDY_CONFIG || path.join(root, 'study.yaml')];

  let config;
  try {
    for (const f of configFiles) {
      config = loadConfig(f);
      if (validateOnly) console.log(`OK  ${f}`);
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  if (validateOnly) return;

  const storage = await createStorage({
    mongoUri: process.env.MONGO_URI,
    dataDir: process.env.DATA_DIR || path.join(root, 'data'),
    studyId: config.study.id,
  });
  const app = createApp({ config, storage });
  const port = await app.listen(Number(process.env.PORT) || 3000);
  console.log(`syncchat: study "${config.study.id}" listening on port ${port} (storage: ${storage.backend})`);
  if (!process.env.ADMIN_TOKEN) console.log('syncchat: ADMIN_TOKEN not set, /export is disabled');

  const shutdown = async () => {
    await app.close();
    await storage.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
