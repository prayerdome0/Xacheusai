/**
 * Xacheus AI backend entry point.
 *
 * Boots the kernel, exposes the API, and prints an honest summary of what is
 * configured and what is not — because with a private agent you should never have
 * to guess which parts are live.
 */
import 'dotenv/config';
import { getServer } from './kernel-instance.js';

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '0.0.0.0';

  // getServer() reuses a warm kernel and refuses to boot with throwaway storage
  // on a platform that cannot keep it. See storage-guard.ts.
  const handle = await getServer();
  const { kernel, storage } = handle;
  const { app, auth } = handle.built;

  const { services } = kernel;
  const connectors = services.connectors.statuses();
  const live = connectors.filter((connector) => connector.mode === 'live');
  const missing = connectors.filter((connector) => connector.mode === 'sandbox' && connector.missingFields.length);

  await app.listen({ port, host });

  const line = '─'.repeat(64);
  const log = (message: string) => process.stdout.write(`${message}\n`);

  log(line);
  log('  XACHEUS AI — backend running');
  log(line);
  log(`  URL            http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  log(`  Auth           ${auth.mode}`);
  log(`  Storage        ${services.storage.id}${storage.durable ? ' (durable)' : ' (NOT durable)'}`);
  if (!storage.durable) log(`   • ${storage.detail}`);
  log(`  Model layer    ${services.models.active.label} (${services.models.active.locality})`);
  log(`  Tools          ${services.tools.list().length} registered`);
  log(`  Automations    ${(await services.automations.list()).filter((automation) => automation.enabled).length} enabled`);
  log(`  Workspace root ${services.workspaceRoot}`);
  log(`  Runtime        ${handle.perInstance ? 'serverless — console polls, automations need a cron' : `long-running process (instance ${handle.reused ? 'reused' : 'fresh'})`}`);
  log(line);
  log(`  Connectors live: ${live.length}/${connectors.length}${live.length ? ` (${live.map((connector) => connector.id).join(', ')})` : ''}`);
  if (missing.length) {
    for (const connector of missing) {
      log(`   • ${connector.id} runs in sandbox mode — missing: ${connector.missingFields.join(', ')}`);
    }
  }
  for (const note of [...services.models.notes, ...(auth.warning ? [auth.warning] : [])]) {
    log(`  ! ${note}`);
  }
  if (!storage.durable && storage.warning) log(`  ! ${storage.warning}`);
  log(line);

  const shutdown = async (signal: string): Promise<void> => {
    log(`\n${signal} received — shutting down cleanly.`);
    await app.close();
    await kernel.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  process.stderr.write(`Xacheus failed to start: ${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
