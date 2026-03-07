import type { ScaleName } from './types';

const SCALE_INTERVALS: Record<ScaleName, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  pentatonic: [0, 2, 4, 7, 9],
};

const SAFE_MIN_MIDI = 48; // C3
const SAFE_MAX_MIDI = 72; // C5
const ROOT_PITCH_CLASS = 0; // C

export function buildScaleNotes(scale: ScaleName): number[] {
  const intervals = new Set(SCALE_INTERVALS[scale]);
  const notes: number[] = [];

  for (let midi = SAFE_MIN_MIDI; midi <= SAFE_MAX_MIDI; midi += 1) {
    const interval = ((midi - ROOT_PITCH_CLASS) % 12 + 12) % 12;
    if (intervals.has(interval)) {
      notes.push(midi);
    }
  }

  return notes;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function toPitchValue(x: number, y: number, sensitivity: number): number {
  const combined = (0.55 * y) + (0.45 * -x);
  return clamp(combined * sensitivity, -1, 1);
}

export function quantizePitchToMidi(pitchValue: number, notes: number[]): number {
  if (notes.length === 0) {
    return 60;
  }

  const normalized = (pitchValue + 1) * 0.5;
  const index = Math.round(normalized * (notes.length - 1));
  return notes[clamp(index, 0, notes.length - 1)];
}
