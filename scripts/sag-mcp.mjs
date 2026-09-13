#!/usr/bin/env node

/**
 * scripts/sag-mcp.mjs — the command/observe loop, spoken as MCP tools instead of npm
 * scripts.
 *
 * `sag-command.mjs` and `sag-observe.mjs` already ARE the interface: one plays the synth,
 * one answers "did it make sound", and neither invents anything `dispatch`/the observer
 * did not already do. This file adds no third opinion of what a command or a verdict is —
 * it spawns the first script and fetches the second's data source, then hands the same
 * text either would have printed to an MCP client instead of a terminal.
 *
 * Plain `.mjs`, same reason as its siblings: typing it means `@types/node`, which the
 * contract keeps out of everything `tsconfig.json` includes so `src/core/**` stays
 * environment-free. This lives outside that boundary already.
 *
 * Three tools:
 *   sag_command  — play the synth. Wraps `sag-command.mjs`, same env override
 *                  (SAG_ENDPOINT) and exit-code semantics, just returned as text.
 *   sag_observe  — read the observation log and print `sag-observe.mjs`'s own verdict.
 *                  Source is a URL (Android shell's `/__sag/observe?tail=N`) or, if
 *                  SAG_OBSERVE_LOG already points at a local JSONL file (the dev-server
 *                  case), reads that directly — either way the interpretation is
 *                  `sag-observe.mjs`'s, not a second copy of it here.
 *   sag_health   — GET the shell's health endpoint, raw passthrough.
 *
 * Endpoints default to the Android shell's fixed loopback port (8765) rather than the dev
 * server's (5173, `sag-command.mjs`'s own default) — this script's reason to exist is
 * driving a build with no Vite dev server behind it. Every default is overridable by env
 * for the dev-server case.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_COMMAND_ENDPOINT = 'http://127.0.0.1:8765/__sag/command';
const DEFAULT_OBSERVE_URL = 'http://127.0.0.1:8765/__sag/observe?tail=500';
const DEFAULT_HEALTH_URL = 'http://127.0.0.1:8765/__sag/health';

/** Run a script with node, collect its stdout/stderr/exit code — never throws. */
function runNode(scriptPath, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error) }));
  });
}

const TOOLS = [
  {
    name: 'sag_command',
    description:
      'Play the running synth. `commands` is a SynthCommand object, an array of them, or ' +
      'their JSON-encoded string form — the same shapes `npm run command --` accepts. ' +
      'Set SAG_ENDPOINT to override the target (defaults to the Android shell at ' +
      '127.0.0.1:8765).',
    inputSchema: {
      type: 'object',
      properties: {
        commands: {
          description: 'A command object/array, or its JSON string form.',
        },
        gapMs: { type: 'number', description: 'ms between commands in a sequence.' },
      },
      required: ['commands'],
    },
  },
  {
    name: 'sag_observe',
    description:
      'Answer "did the synth make sound?" by fetching the observation log (SAG_OBSERVE_URL, ' +
      'default the Android shell\'s /__sag/observe?tail=500) and printing sag-observe.mjs\'s ' +
      'own verdict over it.',
    inputSchema: {
      type: 'object',
      properties: {
        windowSeconds: {
          type: 'number',
          description: 'Restrict the verdict to the last N seconds, as with the CLI arg.',
        },
      },
    },
  },
  {
    name: 'sag_health',
    description: 'GET the shell\'s health endpoint (SAG_HEALTH_URL, default 127.0.0.1:8765).',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function handleSagCommand(args) {
  const raw = args?.commands;
  if (raw === undefined) throw new Error('sag_command requires `commands`.');
  const asString = typeof raw === 'string' ? raw : JSON.stringify(raw);

  const cliArgs = [];
  if (typeof args?.gapMs === 'number') cliArgs.push('--gap', String(args.gapMs));
  cliArgs.push(asString);

  const endpoint = process.env.SAG_ENDPOINT ?? DEFAULT_COMMAND_ENDPOINT;
  const result = await runNode(join(__dirname, 'sag-command.mjs'), cliArgs, {
    SAG_ENDPOINT: endpoint,
  });
  return { text: (result.stdout + result.stderr).trim() || `(exit ${result.code}, no output)` };
}

async function handleSagObserve(args) {
  const url = process.env.SAG_OBSERVE_URL ?? DEFAULT_OBSERVE_URL;

  let body;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = await response.text();
  } catch (error) {
    return {
      text: `could not fetch observations from ${url}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  // `sag-observe.mjs` reads a local JSONL FILE, not a URL — its interpretation is what
  // this tool wants to reuse, so the fetched body is written to a temp file and the
  // script's own SAG_OBSERVE_LOG override is pointed at it, rather than re-implementing
  // its verdict logic here a second time.
  const dir = mkdtempSync(join(tmpdir(), 'sag-observe-'));
  const logPath = join(dir, 'audio-observed.jsonl');
  writeFileSync(logPath, body);

  try {
    const cliArgs = typeof args?.windowSeconds === 'number' ? [String(args.windowSeconds)] : [];
    const result = await runNode(join(__dirname, 'sag-observe.mjs'), cliArgs, {
      SAG_OBSERVE_LOG: logPath,
    });
    return { text: (result.stdout + result.stderr).trim() || `(exit ${result.code}, no output)` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function handleSagHealth() {
  const url = process.env.SAG_HEALTH_URL ?? DEFAULT_HEALTH_URL;
  try {
    const response = await fetch(url);
    const body = await response.text();
    return { text: `HTTP ${response.status}\n${body}` };
  } catch (error) {
    return { text: `could not reach ${url}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function main() {
  const server = new Server(
    { name: 'sag-synth-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    let outcome;
    try {
      if (name === 'sag_command') outcome = await handleSagCommand(args ?? {});
      else if (name === 'sag_observe') outcome = await handleSagObserve(args ?? {});
      else if (name === 'sag_health') outcome = await handleSagHealth();
      else throw new Error(`unknown tool: ${name}`);
    } catch (error) {
      return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: outcome.text }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC transport now; anything else written to it would be read as a
  // malformed message, so status goes to stderr, same discipline as the reference server.
  console.error('sag-synth MCP server started (stdio).');
}

main().catch((error) => {
  console.error('sag-mcp failed to start:', error);
  process.exit(1);
});
