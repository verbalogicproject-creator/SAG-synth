/**
 * src/tests/contract.test.ts — the drift tripwire.
 *
 * Phase 2 fans out five agents with zero visibility into each other. The only thing
 * stopping them from inventing incompatible types is that this contract is frozen, and
 * the only thing that makes "frozen" mean anything is a test that fails when it moves.
 *
 * Every list below is written out longhand on purpose. Deriving the expectation from
 * the code under test would make the test agree with any change, which is exactly the
 * failure mode a tripwire exists to prevent.
 *
 * Lives in src/tests/ rather than src/core/ so that `src/core/**` really does import
 * nothing but zod — including its tests. `core imports only zod` below proves it.
 */

import { describe, expect, it } from 'vitest';
import {
  COMMAND_SOURCES,
  HISTORY_COMMAND_TYPES,
  HOT_PATH_COMMAND_TYPES,
  SYNTH_COMMAND_TYPES,
  SYNTH_QUERY_TYPES,
  TRANSIENT_COMMAND_TYPES,
  advancesRevision,
  assertEnvelopeConsistent,
  createEnvelope,
} from '../core/commands';
import { PARAM_PATHS, PARAM_SPECS } from '../core/schemas';
import {
  KIND_SYNTH_PATCH_REQUIRED_SLOTS,
  KIND_SYNTH_PATCH_SLOT_MAP,
  KIND_SYNTH_SONG_REQUIRED_SLOTS,
  KIND_SYNTH_SONG_SLOT_MAP,
  SYNTH_COMMAND_APPLIED_KIND,
  SYNTH_COMMAND_APPLIED_OPTIONAL_SLOTS,
  SYNTH_COMMAND_APPLIED_REQUIRED_SLOTS,
  buildCommandAppliedEvent,
  hasRequiredSlots,
} from '../core/sag/events';
import { MAX_LFOS } from '../core/types';

// ---------------------------------------------------------------------------

/** The command surface, verbatim from the frozen contract. 34 verbs. */
const FROZEN_COMMAND_TYPES = [
  // patch
  'loadPreset',
  'savePreset',
  'deletePreset',
  'setParam',
  'addLfo',
  'removeLfo',
  'setEffectEnabled',
  'setMasterVolume',
  // song
  'newSong',
  'loadSong',
  'saveSong',
  'deleteSong',
  'importSongFile',
  'addTrack',
  'removeTrack',
  'renameTrack',
  'setTrackParam',
  'setStep',
  'setPatternLength',
  'addNote',
  'removeNote',
  'setTempo',
  'setSwing',
  'setTimeSignature',
  // playback
  'play',
  'stop',
  'pause',
  'seek',
  'setLoop',
  'noteOn',
  'noteOff',
  'panic',
  // midi
  'importMidi',
  // history
  'undo',
  'redo',
];

describe('command surface is frozen', () => {
  it('declares exactly the 34 verbs in the contract, in order', () => {
    expect([...SYNTH_COMMAND_TYPES]).toEqual(FROZEN_COMMAND_TYPES);
  });

  it('has no duplicate discriminants', () => {
    expect(new Set(SYNTH_COMMAND_TYPES).size).toBe(SYNTH_COMMAND_TYPES.length);
  });

  it('marks exactly noteOn and noteOff as hot path', () => {
    // The latency bypass: synchronous runtime call, asynchronous journal. Widening
    // this set changes the engine's latency profile.
    expect([...HOT_PATH_COMMAND_TYPES]).toEqual(['noteOn', 'noteOff']);
  });

  it('marks exactly the four transient commands as not advancing revision', () => {
    // None of these has anything in EngineState to change, so bumping `revision` for
    // them would make it a meaningless counter rather than a document version
    // (KIND-synth_command_applied §5). Widening this set changes replay semantics.
    expect([...TRANSIENT_COMMAND_TYPES]).toEqual(['noteOn', 'noteOff', 'seek', 'panic']);
  });

  it('keeps the hot path a strict subset of the transient set', () => {
    for (const type of HOT_PATH_COMMAND_TYPES) {
      expect(TRANSIENT_COMMAND_TYPES).toContain(type);
    }
  });

  it('marks exactly undo and redo as history commands', () => {
    // These RESTORE a revision rather than advancing one, and are the only commands the
    // reducer refuses outright — src/core/history.ts owns them, because they need the
    // state stack and `reduce` must stay a pure function of a single state.
    expect([...HISTORY_COMMAND_TYPES]).toEqual(['undo', 'redo']);
  });

  it('keeps the transient and history categories disjoint', () => {
    const transient = new Set<string>(TRANSIENT_COMMAND_TYPES);
    for (const type of HISTORY_COMMAND_TYPES) {
      expect(transient.has(type), `${type} cannot be both transient and history`).toBe(false);
    }
  });

  it('advancesRevision agrees with the transient and history sets for every verb', () => {
    const nonAdvancing = new Set<string>([...TRANSIENT_COMMAND_TYPES, ...HISTORY_COMMAND_TYPES]);
    for (const type of SYNTH_COMMAND_TYPES) {
      // Only the discriminant is read, so a bare stub is enough here.
      const command = { type } as unknown as Parameters<typeof advancesRevision>[0];
      expect(advancesRevision(command), type).toBe(!nonAdvancing.has(type));
    }
  });

  it('accepts ui, agent, and replay as command sources', () => {
    // `agent` is the v0.2 SAG-SDK path — present from v0.1.0 so the SDK needs no
    // domain change later.
    expect([...COMMAND_SOURCES]).toEqual(['ui', 'agent', 'replay']);
  });

  it('keeps the five queries read-only and out of the command union', () => {
    expect([...SYNTH_QUERY_TYPES]).toEqual([
      'getState',
      'listPresets',
      'listSongs',
      'exportSong',
      'exportPresetFile',
    ]);
    for (const query of SYNTH_QUERY_TYPES) {
      expect(SYNTH_COMMAND_TYPES).not.toContain(query as never);
    }
  });
});

// ---------------------------------------------------------------------------

/** Open question Q2: setParam.path is a finite union, never an arbitrary string. */
const FROZEN_FIXED_PARAM_PATHS = [
  'voice.oscillator.type',
  'voice.oscillator.detune',
  'voice.oscillator.count',
  'voice.oscillator.spread',
  'voice.oscillator.width',
  'voice.envelope.attack',
  'voice.envelope.decay',
  'voice.envelope.sustain',
  'voice.envelope.release',
  'voice.filter.type',
  'voice.filter.frequency',
  'voice.filter.Q',
  'voice.filter.rolloff',
  'voice.filterEnvelope.attack',
  'voice.filterEnvelope.decay',
  'voice.filterEnvelope.sustain',
  'voice.filterEnvelope.release',
  'voice.filterEnvelope.baseFrequency',
  'voice.filterEnvelope.octaves',
  'voice.polyphony',
  'voice.portamento',
  'voice.stealPolicy',
  'voice.velocity.toAmplitude',
  'voice.velocity.toFilterOctaves',
  'effects.distortion.amount',
  'effects.distortion.wet',
  'effects.chorus.frequency',
  'effects.chorus.delayTime',
  'effects.chorus.depth',
  'effects.chorus.wet',
  'effects.delay.delayTime',
  'effects.delay.feedback',
  'effects.delay.wet',
  'effects.reverb.roomSize',
  'effects.reverb.dampening',
  'effects.reverb.wet',
  'master.volume',
  'master.limiterThreshold',
];

const FROZEN_LFO_PARAM_KEYS = [
  'enabled',
  'target',
  'type',
  'frequency',
  'min',
  'max',
  'sync',
  'retrigger',
];

describe('parameter surface is frozen (open question Q2)', () => {
  it('declares exactly the fixed paths plus MAX_LFOS x 8 LFO paths', () => {
    const expectedLfoPaths = Array.from({ length: MAX_LFOS }, (_unused, i) => i).flatMap((i) =>
      FROZEN_LFO_PARAM_KEYS.map((key) => `voice.lfos.${i}.${key}`),
    );
    expect([...PARAM_PATHS].sort()).toEqual(
      [...FROZEN_FIXED_PARAM_PATHS, ...expectedLfoPaths].sort(),
    );
  });

  it('caps LFOs at 4, which is what keeps the path union finite', () => {
    expect(MAX_LFOS).toBe(4);
    expect(PARAM_PATHS).toHaveLength(FROZEN_FIXED_PARAM_PATHS.length + MAX_LFOS * 8);
  });

  it('gives every path a range spec, so no parameter is unvalidated', () => {
    for (const path of PARAM_PATHS) {
      const spec = PARAM_SPECS[path];
      expect(spec, `${path} has no spec`).toBeDefined();
      if (spec.kind === 'number') {
        expect(spec.min, `${path} min/max inverted`).toBeLessThan(spec.max);
      }
      if (spec.kind === 'enum') {
        expect(spec.values.length, `${path} enum is empty`).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe('SAG substrate matches the declared KINDs', () => {
  it('names the event kind exactly as KIND-synth_command_applied declares it', () => {
    expect(SYNTH_COMMAND_APPLIED_KIND).toBe('synth.command_applied');
  });

  it('declares the eight required slots slot-for-slot, in the KIND order', () => {
    expect([...SYNTH_COMMAND_APPLIED_REQUIRED_SLOTS]).toEqual([
      'command_id',
      'command_type',
      'payload',
      'status',
      'seq',
      'revision',
      'source',
      'ts',
    ]);
  });

  it('declares the six optional slots', () => {
    expect([...SYNTH_COMMAND_APPLIED_OPTIONAL_SLOTS]).toEqual([
      'error',
      'session_id',
      'song_id',
      'preset_id',
      'duration_us',
      'last_acked_seq',
    ]);
  });

  it('builds an event carrying the command verbatim (F62)', () => {
    const command = { type: 'setTempo', bpm: 128 } as const;
    const envelope = createEnvelope(command, 'agent', 'cmd-1', 1700000000000);
    assertEnvelopeConsistent(envelope);

    const event = buildCommandAppliedEvent(envelope, { status: 'applied' }, { seq: 0, revision: 1 });

    expect(hasRequiredSlots(event)).toBe(true);
    expect(event.payload).toEqual(command);
    expect(event.command_type).toBe('setTempo');
    expect(event.source).toBe('agent');
    expect(event.error).toBeUndefined();
  });

  it('carries the rejection reason and holds revision flat (F61)', () => {
    const command = { type: 'setTempo', bpm: 9000 } as const;
    const envelope = createEnvelope(command, 'ui', 'cmd-2', 1700000000001);
    const event = buildCommandAppliedEvent(
      envelope,
      { status: 'rejected', error: 'setTempo rejected — bpm out of range' },
      { seq: 1, revision: 1 },
    );

    expect(event.status).toBe('rejected');
    expect(event.error).toContain('out of range');
    // A rejection consumes a seq but not a revision.
    expect(event.seq).toBe(1);
    expect(event.revision).toBe(1);
  });

  it('maps every required synth_patch slot to a real SynthPreset field', () => {
    for (const slot of KIND_SYNTH_PATCH_REQUIRED_SLOTS) {
      expect(
        KIND_SYNTH_PATCH_SLOT_MAP,
        `KIND-synth_patch slot "${slot}" has no field mapping`,
      ).toHaveProperty(slot);
    }
  });

  it('maps every required synth_song slot to a real Song field', () => {
    for (const slot of KIND_SYNTH_SONG_REQUIRED_SLOTS) {
      expect(
        KIND_SYNTH_SONG_SLOT_MAP,
        `KIND-synth_song slot "${slot}" has no field mapping`,
      ).toHaveProperty(slot);
    }
  });
});

// ---------------------------------------------------------------------------

describe('layer rule D2', () => {
  // Read core's own source through Vite rather than node:fs — @types/node is
  // deliberately not a dependency, and this keeps the check dependency-free.
  const coreSources = import.meta.glob('../core/**/*.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;

  /**
   * All four ways a module can pull in a dependency. An earlier version of this test
   * only matched `from '...'` and cheerfully let `import 'tone';` through — a purity
   * gate with a hole in it is worse than no gate, because it is believed.
   */
  const SPECIFIER_PATTERNS = [
    /^[ \t]*(?:import|export)\b[\s\S]*?from\s*['"]([^'"]+)['"]/gm, // static import/re-export
    /^[ \t]*import\s+['"]([^'"]+)['"]/gm, // side-effect import
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g, // dynamic import
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g, // cjs escape hatch
  ];

  function specifiersIn(source: string): string[] {
    return SPECIFIER_PATTERNS.flatMap((pattern) =>
      [...source.matchAll(pattern)].map((match) => match[1]!),
    );
  }

  it('finds the core files it is meant to be policing', () => {
    // Guards against the glob silently matching nothing and the test passing vacuously.
    expect(Object.keys(coreSources).length).toBeGreaterThanOrEqual(6);
  });

  it('detects each of the four import forms', () => {
    // The gate itself is under test: if this drifts, the check above goes quiet.
    expect(specifiersIn("import { z } from 'zod';")).toContain('zod');
    expect(specifiersIn("import 'tone';")).toContain('tone');
    expect(specifiersIn("const t = await import('tone');")).toContain('tone');
    expect(specifiersIn("const t = require('tone');")).toContain('tone');
    expect(specifiersIn("import {\n  a,\n} from './types';")).toContain('./types');
  });

  it('core imports only zod and its own siblings', () => {
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(coreSources)) {
      for (const specifier of specifiersIn(source)) {
        if (!specifier.startsWith('.') && specifier !== 'zod') {
          offenders.push(`${file} imports "${specifier}"`);
        }
      }
    }
    // `tone` or `react` here means core can no longer run under plain Node, which is
    // the entire v0.2 SAG-SDK seam.
    expect(offenders).toEqual([]);
  });

  it('core touches no DOM or browser global', () => {
    const FORBIDDEN = /\b(document|window|navigator|localStorage|AudioContext|indexedDB)\b/;
    const offenders = Object.entries(coreSources)
      .filter(([, source]) => FORBIDDEN.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The app layer. Core's gate says "zod only"; app's is looser but not absent —
  // an ungated layer is where the rule quietly stops being true.
  // -------------------------------------------------------------------------

  const appSources = import.meta.glob('../app/**/*.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;

  /**
   * app is the adapter layer, so it may reach the packages core cannot: `idb` for
   * storage, `@tonejs/midi` for parsing. `tone` is deliberately absent — audio belongs
   * to src/runtime/, and app composing runtime is what keeps the runtime swappable for
   * NullRuntime. Adding an entry here should be a decision, not a reflex.
   */
  const APP_ALLOWED_PACKAGES = new Set(['zod', 'idb', '@tonejs/midi']);

  it('finds the app files it is meant to be policing', () => {
    expect(Object.keys(appSources).length).toBeGreaterThanOrEqual(4);
  });

  it('app imports only its declared adapter packages', () => {
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(appSources)) {
      for (const specifier of specifiersIn(source)) {
        if (!specifier.startsWith('.') && !APP_ALLOWED_PACKAGES.has(specifier)) {
          offenders.push(`${file} imports "${specifier}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('app never imports the UI', () => {
    // This is the gate that protects v0.2. The SAG-SDK drives the dispatcher with no
    // React mounted at all; the moment app reaches into src/clients/ — or pulls in
    // react directly — the engine stops being headless and the SDK needs a browser.
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(appSources)) {
      for (const specifier of specifiersIn(source)) {
        if (/(^|\/)clients(\/|$)/.test(specifier) || /^react(-dom)?(\/|$)/.test(specifier)) {
          offenders.push(`${file} imports "${specifier}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('app never imports the concrete audio runtime', () => {
    // The package allowlist above bans `tone` directly, but `../runtime/tone-runtime`
    // is a relative specifier and would sail straight through it — pulling Tone into
    // src/app/ transitively and breaking the headless path just as effectively.
    // `createEngine` takes the runtime as a PARAMETER precisely so this stays true.
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(appSources)) {
      for (const specifier of specifiersIn(source)) {
        // `../core/runtime-contract` is the interface and is fine; only the directory
        // is barred, which is why this matches a whole path segment.
        if (/(^|\/)runtime(\/|$)/.test(specifier)) offenders.push(`${file} imports "${specifier}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('detects a UI import if one appeared', () => {
    // Test-of-the-test: the matchers above are the whole gate, so prove they fire on
    // the exact specifiers they exist to catch rather than trusting them to.
    const uiLike = (s: string) => /(^|\/)clients(\/|$)/.test(s) || /^react(-dom)?(\/|$)/.test(s);
    expect(uiLike('../clients/ui/store')).toBe(true);
    expect(uiLike('react')).toBe(true);
    expect(uiLike('react-dom/client')).toBe(true);
    // ...and stay quiet on things that merely look similar.
    expect(uiLike('../core/ports')).toBe(false);
    expect(uiLike('react-is-not-a-real-dep')).toBe(false);

    const runtimeLike = (s: string) => /(^|\/)runtime(\/|$)/.test(s);
    expect(runtimeLike('../runtime/tone-runtime')).toBe(true);
    expect(runtimeLike('../../runtime')).toBe(true);
    // The interface lives in core and must NOT be caught by the directory ban.
    expect(runtimeLike('../core/runtime-contract')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // The audio runtime and the clients. Both are new; neither had a gate before.
  // -------------------------------------------------------------------------

  const runtimeSources = import.meta.glob('../runtime/**/*.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;

  const clientSources = import.meta.glob('../clients/**/*.{ts,tsx}', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;

  it('finds the runtime and client files it is meant to be policing', () => {
    expect(Object.keys(runtimeSources).length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(clientSources).length).toBeGreaterThanOrEqual(3);
  });

  it('runtime imports tone and core, and nothing else', () => {
    // This subtree is the ONLY place `tone` is allowed. Equally important is the other
    // direction: a runtime that reached up into src/app/ or src/clients/ would invert
    // the dependency and make NullRuntime unswappable — and that swap IS the SDK seam.
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(runtimeSources)) {
      for (const specifier of specifiersIn(source)) {
        if (!specifier.startsWith('.') && specifier !== 'tone') {
          offenders.push(`${file} imports package "${specifier}"`);
        }
        if (/(^|\/)(app|clients)(\/|$)/.test(specifier)) {
          offenders.push(`${file} reaches upward into "${specifier}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('clients never touch the audio graph directly', () => {
    // A client that called Tone.js itself could make a sound that no journal records,
    // so the session would replay into a different performance than the one played.
    // Every note must go through the dispatcher.
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(clientSources)) {
      for (const specifier of specifiersIn(source)) {
        if (specifier === 'tone' || specifier.startsWith('tone/')) {
          offenders.push(`${file} imports "${specifier}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
