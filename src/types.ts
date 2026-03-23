export type ScaleName = 'major' | 'pentatonic';

export type HandId = 'left' | 'right';

export interface AppSettings {
  scale: ScaleName;
  sensitivity: number;
  smoothing: number;
  leftPreset: SynthPresetName;
  rightPreset: SynthPresetName;
  masterVolume: number;
  leftVolume: number;
  rightVolume: number;
}

export interface Point2D {
  x: number;
  y: number;
}

export interface TrackedHand {
  id: HandId;
  point: Point2D;
}

export interface DetectionFrame {
  hands: TrackedHand[];
}

export type SynthPresetName = 'calm-air' | 'warm-pad' | 'glass' | 'ethereal';
