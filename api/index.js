/**
 * Vercel serverless entry point.
 *
 * One catch-all function serves the entire API. Three things make this honest
 * rather than aspirational:
 *
 *  1. **The kernel is cached across invocations.** Node re-evaluates modules
 *     between warm starts more often than people expect, so the built server is
 *     cached on `globalThis` — warm instances reuse it instead of re-reading
 *     every collection on every request.
 *  2. **It refuses to lie about durability.** Local JSON files are fine on a box
 *     and wrong here (ephemeral disk, several instances). `storage-guard.ts`
 *     refuses to boot unless Firestore is configured or you explicitly opt in to
 *     throwaway data.
 *  3. **Gaps are reported, not hidden.** No WebSockets and no in-process
 *     scheduler on this platform, so `GET /api/runtime` says so, the console
 *     falls back to polling, the Android app uses its polling transport, and
 *     `GET/POST /api/tasks/tick` drives automations from a cron.
 *
 * Everything else is the same kernel the long-running server uses: same tools,
 * same permission engine, same confirmations, same audit log.
 *
 * This file is plain JS on purpose: Vercel builds it without a transpile step,
 * and it imports the compiled server from `apps/server/dist` (produced by
 * `npm run build`, which is the project's build command).
 */

/** @type {Promise<{ built: import('fastify').FastifyInstance, handle: any }> | null} */
let instance = null;

async function boot() {
  const { getServer } = await import('../apps/server/dist/kernel-instance.js');
  const handle = await getServer();
  await handle.built.app.ready();
  return { handle, app: handle.built.app };
}

async function handler(request, response) {
  try {
    instance ??= boot();
    const { app } = await instance;

    // Fastify's documented custom-server hook: hand it the raw request once.
    app.routing(request, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Configuration problems deserve a legible answer rather than a stack trace.
    // The most common one by far is "you need durable storage on this platform".
    response.statusCode = 503;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(
      JSON.stringify(
        {
          error: 'xacheus_not_configured',
          message,
          docs: 'https://github.com/prayerdome0/Xacheusai/blob/main/DEPLOY.md',
          hint: [
            'XACHEUS_STORAGE=firestore + FIREBASE_SERVICE_ACCOUNT_JSON (durable data across instances)',
            'XACHEUS_OWNER_PASSCODE (required: never expose an open agent)',
            'XACHEUS_DEVICE_BRIDGE_TOKEN (required for the Android app)',
            'FIREBASE_PROJECT_ID (enables Firebase sign-in and ID-token auth)',
          ],
        },
        null,
        2,
      ),
    );
  }
}

export default handler;
// Vercel's Node runtime can also invoke a named export.
export { handler };
