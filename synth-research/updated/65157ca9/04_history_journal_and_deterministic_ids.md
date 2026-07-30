# 04 — Journaled Undo/Redo, Injected IDs, and Pure Constructors

## Aligned rule set
1. **Undo/redo are journaled commands**, not a client-side store cursor.
2. **IDs and timestamps are injected above the core**, never generated or read inside it.

## Why undo/redo changed
The original pack recommended `zustand` + `zundo`'s `temporal` store for undo/redo. That was installed, but is unused — a client-side undo cursor makes live state disagree with its own history. If the journal doesn't record the undo, replaying it rebuilds the *pre*-undo state, so the undo would not survive a reload, and the journal would stop being the single source of truth.

Making undo a recorded verb forced a second architectural split: the reducer must be a pure function of **one** state and **one** command, so it cannot itself implement undo (which needs a stack). The reducer refuses `undo`/`redo` outright, and a separate driver above it owns the past/future stacks.

```ts
// core/reduce.ts
export function reduce(state: EngineState, cmd: DomainCommand): EngineState {
  switch (cmd.type) {
    case 'undo':
    case 'redo':
      throw new Error('undo/redo handled by history driver, not the reducer');
    default:
      return reduceRegular(state, cmd);
  }
}
```

```ts
// app/dispatch.ts
export function dispatch(envelope: AnyEnvelope) {
  historyDriver.apply(envelope); // owns past/future stacks and journaling
  runtimeBridge.sync(historyDriver.present());
}
```

`zustand`/`zundo` remain in `package.json` as dead weight; a future cleanup should remove them rather than re-adopting the temporal store pattern.

## Why deterministic IDs matter
`crypto.randomUUID()` and `Date.now()` are banned below the app layer. Ids and timestamps are injected: the command envelope takes them as parameters, `savePreset`/`newSong` derive the new document's id from the command id, and the MIDI importer takes `songId` / `trackIdFor(trackIndex)` / `noteIdFor(trackIndex, noteIndex)` / `createdAt` from its caller.

A parser that called `randomUUID()` internally would produce a different song on every run of the *same* import, making that import unreplayable. This is treated as the single most invasive constraint in the codebase and should be assumed in any future code sample.

```ts
export interface CommandEnvelope<TType extends string, TPayload> {
  commandId: string;
  issuedAt: string;      // injected ISO timestamp
  actor: 'ui' | 'agent' | 'importer' | 'system';
  type: TType;
  payload: TPayload;
}

interface IdFactory {
  songIdForImport(importCommandId: string): string;
  trackIdFor(songId: string, trackIndex: number): string;
  noteIdFor(trackId: string, noteIndex: number): string;
}
```

`initialEngineState()` should be a pure constant with a frozen factory epoch — no clock read even at startup.
