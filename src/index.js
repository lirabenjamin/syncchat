'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig, loadStudyDir, ConfigError } = require('./config');
const { createStorage } = require('./storage');
const { createApp } = require('./app');

const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

async function main() {
  // A folder (STUDY_DIR, or STUDY_CONFIG pointing at a folder) hosts every study in it, with a gallery at /.
  const target = process.argv[2] || process.env.STUDY_DIR || process.env.STUDY_CONFIG || path.join(root, 'study.yaml');
  const multi = fs.existsSync(target) && fs.statSync(target).isDirectory();
  let loaded;
  try {
    loaded = multi ? loadStudyDir(target) : [{ config: loadConfig(target) }];
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  const studies = [];
  for (const s of loaded) {
    const storage = await createStorage({
      mongoUri: process.env.MONGO_URI,
      dataDir: process.env.DATA_DIR || path.join(root, 'data'),
      studyId: s.config.study.id,
    });
    studies.push({ ...s, storage });
  }
  const app = multi ? createApp({ studies }) : createApp(studies[0]);
  const port = await app.listen(Number(process.env.PORT) || 3000);
  const ids = studies.map((s) => s.config.study.id).join('", "');
  console.log(`syncchat: ${multi ? 'studies' : 'study'} "${ids}" listening on port ${port} (storage: ${studies[0].storage.backend})`);
  if (!process.env.ADMIN_TOKEN) console.log('syncchat: ADMIN_TOKEN not set, /export is disabled');

  const shutdown = async () => {
    await app.close();
    await Promise.all(studies.map((s) => s.storage.close()));
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
