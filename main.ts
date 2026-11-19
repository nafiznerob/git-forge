// Entry lifecycle: bind an ephemeral port, register it with the suite,
// then poll until the suite says the trial is over and exit 0.
//
//   MAKEFUN_ENV_URL names the suite origin. Without it there is nothing to
//   talk to, so the process exits 1 at once.
//   listen(0) lets the kernel pick a free port; 8080 is the suite's own
//   port and is never bound here.
//   POST $MAKEFUN_ENV_URL/register {"port": N} tells the suite where the
//   forge listens. A 409 means a first registration already won; waiting
//   is still the right move.
//   GET $MAKEFUN_ENV_URL/done answers {"done": false} while the suite
//   runs and {"done": true} when it has finished and written its export.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<number> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  await res.text().catch(() => undefined);
  return res.status;
}

async function register(port: number): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const status = await postJson(`${ENV_URL}/register`, { port }, 30_000);
      if (status === 200 || status === 409) return;
      if (status === 400 || status === 405) throw new Error(`register answered HTTP ${status}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    attempt += 1;
    await sleep(Math.min(2000, 250 * 2 ** Math.min(attempt, 8)));
  }
}

async function waitForDone(): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not done yet (or the env is still starting): keep polling.
    }
    attempt += 1;
    await sleep(Math.min(2000, 250 * 2 ** Math.min(attempt, 8)));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);
  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await waitForDone();
  // The suite has finished: stop accepting new connections and wait for
  // the in-flight ones to drain before exiting.
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
