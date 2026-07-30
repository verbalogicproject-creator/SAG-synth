import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * scripts/sag-observe-plugin.mjs — receives audio observations from the browser.
 *
 * Plain `.mjs`, outside `tsconfig.json`'s `include`, and that is deliberate rather than
 * lazy. This is the only Node code in the project, and typing it would mean adding
 * `@types/node` — which the contract explicitly refuses, because keeping Node types out is
 * one of the guarantees that `src/core/**` stays environment-free and can run anywhere the
 * v0.2 SDK needs it to. A build-time plugin is not worth spending that on, so it lives
 * where the app's type-checker never looks.
 *
 * What it is for: the synth runs on a phone, every audio gate runs in an offline render on
 * the development machine, and the gap between those two is where a silent-but-passing
 * build hid for five debugging rounds. This writes what the master bus is actually doing to
 * a file that anyone — a person or an agent — can read.
 *
 * `apply: 'serve'` is load-bearing. The route exists in the dev server and nowhere else, so
 * a production build has no endpoint to post to even if a client were misconfigured to
 * try. Development-only is enforced by the bundler rather than by a flag someone can flip.
 */

export const OBSERVE_ROUTE = '/__sag/observe';
export const OBSERVE_LOG = '.sag/audio-observed.jsonl';

export function sagObserveReceiver() {
  return {
    name: 'sag-observe-receiver',
    apply: 'serve',
    configureServer(server) {
      mkdirSync(dirname(OBSERVE_LOG), { recursive: true });
      server.middlewares.use(OBSERVE_ROUTE, (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const rows = Array.isArray(parsed) ? parsed : [parsed];
            // One JSON object per line: appendable without reading the file back, tailable
            // while it is being written, and greppable without a parser.
            appendFileSync(
              OBSERVE_LOG,
              rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
            );
            res.statusCode = 204;
          } catch {
            // A malformed body is the sender's problem and must not take the dev server
            // down — this route serves the app that is being debugged.
            res.statusCode = 400;
          }
          res.end();
        });
      });
    },
  };
}
