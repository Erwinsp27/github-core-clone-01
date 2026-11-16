// Entry point: the conversation between this process and the trial env.
//
// The env owns the trial. This process only has three jobs: bind the forge
// to a port the kernel picks, tell the env which port that is, and stay
// alive until the env declares the trial finished. Nothing else in here
// is scored — the forge itself lives in app.ts.
//
// The exchange, step by step:
//
//   - The env's address comes from MAKEFUN_ENV_URL (in a trial container
//     that is http://store:8080). With no address there is nobody to talk
//     to, so the process gives up at once with exit code 1.
//   - The server listens on port 0, letting the kernel hand out a free
//     one. Port 8080 is the env's own and must never be bound.
//   - POST <env>/register with {"port": N}. The env notes the caller's
//     address plus N and starts dialling the forge there. Whoever registers
//     first wins; a 409 only means someone else won, and this process just
//     carries on waiting like any other.
//   - GET <env>/done, over and over, until the body reads {"done": true}.
//     The env answers immediately ({"done": false} while the suite is still
//     running), so this is a poll with a short pause between rounds, never
//     a request held open. A failed or slow round is retried; the process
//     never leaves before the env says it is done.
//   - Close the server and exit 0. The harness then stops the env, which
//     writes the export the scorer reads.
//
// main.ts imports its own server and nothing else: no package, no Node
// built-in, no model call.

import { createApp } from './app.ts';

/** One HTTP round-trip may take this long before it is dropped and retried. */
const CALL_TIMEOUT_MS = 30_000;
/** First pause between failed rounds, and the longest pause allowed. */
const BACKOFF_START_MS = 250;
const BACKOFF_CEILING_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Pause after `failures` failed rounds: doubles from BACKOFF_START_MS, capped. */
function backoffFor(failures: number): number {
  return Math.min(BACKOFF_CEILING_MS, BACKOFF_START_MS * 2 ** Math.min(failures, 8));
}

/** The env's origin, trailing slashes removed; empty when it was never set. */
function envOrigin(): string {
  return (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
}

const ORIGIN = envOrigin();
if (ORIGIN === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/**
 * Tell the env the port the forge bound. 200 is the usual answer and 409
 * means another entry registered first, which is not this process's
 * problem — either way the announcement is done. 400 and 405 are contract
 * errors and end the program; any other status, or a request that fails
 * outright, is retried, since the env may still be starting up.
 */
async function announcePort(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${ORIGIN}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await pause(backoffFor(failures));
  }
}

/** Keep asking GET /done until it answers {"done": true}; never return sooner. */
async function awaitCompletion(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${ORIGIN}/done`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the round timed out: it is not
      // done, so ask again.
    }
    await pause(backoffFor(failures));
  }
}

/** Bind the forge, announce it, then wait for the env: the whole life of the process. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitCompletion();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
