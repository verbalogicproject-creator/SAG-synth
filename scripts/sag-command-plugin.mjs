/**
 * scripts/sag-command-plugin.mjs — dispatches a command into the running page.
 *
 * The inbound half of the pair whose outbound half is `sag-observe-plugin.mjs`. Together
 * they close a loop that was open for the whole of v0.1: telemetry could say what the
 * synth was doing, and nothing could make it do anything. Answering "is distortion
 * audible" meant driving a headless browser to click pixels, three times, because there
 * was no way to say `setEffectEnabled` and read the meter.
 *
 * **The engine is not here.** It lives in the page, so this route cannot dispatch
 * anything itself. What it does is hand the command to the browser over Vite's own HMR
 * socket and wait for the page to hand back the result — which is why a timeout is a
 * real answer and not a failure mode: "no page answered" means nothing is open, and that
 * is usually the thing you wanted to know.
 *
 * Nothing new is invented on the wire. `SynthCommand` is already a validated,
 * discriminated union with a frozen verb list, and `CommandSource` already has `'agent'`
 * for exactly this caller. The protocol is the schema, which is the point.
 *
 * `apply: 'serve'` is load-bearing, more so than for the observer. A route that dispatches
 * arbitrary commands into a running instrument has no business in a built artifact, and
 * the dev server binds all interfaces, so on a shared network anyone who can reach 5173
 * can play it. That is acceptable for a development tool and would not be for anything
 * else — the bundler enforces the boundary rather than a flag someone can flip.
 *
 * Plain `.mjs` for the same reason as its sibling: typing it would mean `@types/node`,
 * which the contract refuses so `src/core/**` stays environment-free.
 */

export const COMMAND_ROUTE = '/__sag/command';

/** Server → page. Carries `{ id, command }`. */
export const COMMAND_EVENT = 'sag:command';
/** Page → server. Carries `{ id, result }`. */
export const RESULT_EVENT = 'sag:command-result';

const DEFAULT_TIMEOUT_MS = 3000;

export function sagCommandBridge({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return {
    name: 'sag-command-bridge',
    apply: 'serve',
    configureServer(server) {
      // `server.hot` in current Vite, `server.ws` in older. Both carry custom events; the
      // fallback is cheaper than pinning a version this plugin does not otherwise care about.
      const channel = server.hot ?? server.ws;
      const pending = new Map();
      let counter = 0;

      channel.on(RESULT_EVENT, (data) => {
        const entry = pending.get(data?.id);
        if (entry === undefined) return;
        clearTimeout(entry.timer);
        pending.delete(data.id);
        entry.reply(200, data.result ?? null);
      });

      server.middlewares.use(COMMAND_ROUTE, (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }

        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          const reply = (status, payload) => {
            res.statusCode = status;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(payload));
          };

          let command;
          try {
            command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            reply(400, { error: 'body is not JSON' });
            return;
          }

          // Deliberately NOT validated here. `validateCommand` lives in core and is the
          // single gate every command passes; a second copy of that judgement in the dev
          // server is the drift this project keeps paying for. A malformed command comes
          // back as a normal rejection, through the same path the UI uses.
          const id = `http-${(counter += 1)}`;
          const timer = setTimeout(() => {
            pending.delete(id);
            reply(504, {
              error: 'no page answered',
              detail:
                'The command reached the dev server and no browser picked it up. Open the ' +
                'app, or check that connectHotCommandBridge is wired in the client.',
            });
          }, timeoutMs);

          pending.set(id, { reply, timer });
          channel.send({ type: 'custom', event: COMMAND_EVENT, data: { id, command } });
        });
      });
    },
  };
}
