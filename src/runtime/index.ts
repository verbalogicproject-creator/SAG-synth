export type { PatchSection, ToneRuntimeOptions } from './tone-runtime';
export { PATCH_SECTIONS, ToneRuntime, TRANSPORT_LOOKAHEAD } from './tone-runtime';
export type { SynthInstrumentOptions } from './synth-instrument';
export {
  SynthInstrument,
  frequencyEnvelopeOptions,
  oscillatorOptions,
  slotDetune,
  slotGain,
  unsupportedOscillatorFeatures,
  UNMAPPED_PARAMS,
  SHARED_LFO_PHASE_DEPARTURE,
} from './synth-instrument';
export { renderSong, RENDER_LOOKAHEAD, type RenderedSong } from './render-song';
