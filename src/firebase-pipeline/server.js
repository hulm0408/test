// ===== Firebase Phone-Registration Pipeline — Entry Point =====
// Bind 0.0.0.0, live preview proxy support.

import { PipelineCore } from './pipeline-core.js';
import { StateMachine } from './state-machine.js';
import { KeyPool } from './key-pool.js';
import { Dashboard } from './dashboard.js';
import { Ingest } from './ingest.js';
import { PipelineConfig } from './models.ts';

async function main() {
  console.log('🚀 Starting Firebase Phone-Registration Pipeline...');

  // Load config from env
  const config = {
    poolSize: parseInt(process.env.POOL_SIZE || '100', 10),
    keyCap: parseInt(process.env.KEY_CAP || '8', 10),
    backoffFloor: parseInt(process.env.BACKOFF_FLOOR || '1000', 10),
    backoffCeiling: parseInt(process.env.BACKOFF_CEILING || '30000', 10),
    defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || '91',
    rescanInterval: parseInt(process.env.RESCAN_INTERVAL || '60000', 10),
    pipelineDb: process.env.PIPELINE_DB || 'data/pipeline.db',
    maskSecrets: process.env.MASK_SECRETS !== '0',
  } as PipelineConfig;

  // Initialize components
  const sm = new StateMachine(config.pipelineDb);
  const kp = new KeyPool();
  
  // Load keys from env
  const rawKeys = process.env.FIREBASE_API_KEYS || '';
  if (rawKeys) {
    const ingest = new Ingest();
    const parsed = ingest.parseKeys(rawKeys);
    for (const k of parsed.keys) {
      await kp.addKey(k);
    }
  }

  const core = new PipelineCore(config, sm, kp);
  const dashboard = new Dashboard(core, sm, kp, parseInt(process.env.DASHBOARD_PORT || '3000', 10));

  // Start systems
  await core.start();
  await dashboard.start();

  console.log(`✅ Pipeline started. Dashboard on port ${dashboard.port}`);
  console.log(`📊 Config: Pool=${config.poolSize}, Cap=${config.keyCap}, DB=${config.pipelineDb}`);

  // Keep process alive
  process.on('SIGINT', async () => {
    console.log('🛑 Shutting down...');
    await core.stop();
    await dashboard.stop();
    sm.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('🛑 Shutting down...');
    await core.stop();
    await dashboard.stop();
    sm.close();
    process.exit(0);
  });
}

// Run
main().catch(err => {
  console.error('❌ Pipeline failed:', err);
  process.exit(1);
});
