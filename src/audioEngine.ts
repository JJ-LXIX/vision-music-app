import * as Tone from 'tone';
import type { HandId, SynthPresetName } from './types';

interface SynthPreset {
  oscillatorType: 'sine' | 'triangle';
  attack: number;
  release: number;
  reverbDecay: number;
  reverbWet: number;
  gain: number;
  glideSeconds: number;
}

interface VoiceState {
  synth: Tone.Synth;
  gain: Tone.Gain;
  currentMidi: number | null;
  isActive: boolean;
  level: number;
}

const PRESETS: Record<SynthPresetName, SynthPreset> = {
  'calm-air': {
    oscillatorType: 'sine',
    attack: 0.22,
    release: 1.3,
    reverbDecay: 4.8,
    reverbWet: 0.22,
    gain: 0.75,
    glideSeconds: 0.12,
  },
  'warm-pad': {
    oscillatorType: 'triangle',
    attack: 0.28,
    release: 1.6,
    reverbDecay: 5.6,
    reverbWet: 0.28,
    gain: 0.72,
    glideSeconds: 0.14,
  },
  glass: {
    oscillatorType: 'sine',
    attack: 0.12,
    release: 1.0,
    reverbDecay: 3.8,
    reverbWet: 0.18,
    gain: 0.7,
    glideSeconds: 0.1,
  },
  ethereal: {
    oscillatorType: 'triangle',
    attack: 0.36,
    release: 2.4,
    reverbDecay: 8.5,
    reverbWet: 0.42,
    gain: 0.62,
    glideSeconds: 0.18,
  },
};

const HANDS: HandId[] = ['left', 'right'];

export class AudioEngine {
  private readonly reverb: Tone.Reverb;
  private readonly masterGain: Tone.Gain;
  private readonly voices: Record<HandId, VoiceState>;
  private isStarted = false;
  private presetGain = PRESETS['calm-air'].gain;
  private glideSeconds = PRESETS['calm-air'].glideSeconds;

  constructor() {
    const context = new Tone.Context({ latencyHint: 'interactive' });
    Tone.setContext(context);

    this.reverb = new Tone.Reverb({ decay: 4.8, wet: 0.22 });
    this.masterGain = new Tone.Gain(0.8);

    this.voices = {
      left: this.createVoice(),
      right: this.createVoice(),
    };

    this.reverb.connect(this.masterGain);
    this.masterGain.toDestination();
  }

  async start(): Promise<void> {
    if (this.isStarted) {
      return;
    }

    await Tone.start();
    this.isStarted = true;
  }

  setPreset(name: SynthPresetName): void {
    const preset = PRESETS[name];
    this.presetGain = preset.gain;
    this.glideSeconds = preset.glideSeconds;

    for (const hand of HANDS) {
      const voice = this.voices[hand];
      voice.synth.set({
        oscillator: { type: preset.oscillatorType },
        envelope: {
          attack: preset.attack,
          decay: 0.35,
          sustain: 0.85,
          release: preset.release,
        },
      });

      if (voice.isActive) {
        const now = Tone.now();
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
        voice.gain.gain.linearRampToValueAtTime(this.targetGain(hand), now + 0.25);
      }
    }

    this.reverb.set({ decay: preset.reverbDecay, wet: preset.reverbWet });
  }

  setMasterVolume(value: number): void {
    const now = Tone.now();
    const target = clamp01(value);
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
    this.masterGain.gain.linearRampToValueAtTime(target, now + 0.08);
  }

  setHandVolume(hand: HandId, value: number): void {
    const voice = this.voices[hand];
    voice.level = clamp01(value);

    if (!voice.isActive) {
      return;
    }

    const now = Tone.now();
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(this.targetGain(hand), now + 0.08);
  }

  playMidi(hand: HandId, midi: number): void {
    if (!this.isStarted) {
      return;
    }

    const voice = this.voices[hand];
    const now = Tone.now();
    const frequency = Tone.Frequency(midi, 'midi').toFrequency();

    if (!voice.isActive) {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(this.targetGain(hand), now + 0.35);
      voice.synth.triggerAttack(frequency, now, 0.85);
      voice.currentMidi = midi;
      voice.isActive = true;
      return;
    }

    if (voice.currentMidi !== midi) {
      voice.synth.frequency.cancelScheduledValues(now);
      voice.synth.frequency.setValueAtTime(voice.synth.frequency.value, now);
      voice.synth.frequency.linearRampToValueAtTime(frequency, now + this.glideSeconds);
      voice.currentMidi = midi;
    }
  }

  fadeOutAndStop(hand: HandId, durationSeconds = 2.5): void {
    if (!this.isStarted) {
      return;
    }

    const voice = this.voices[hand];
    if (!voice.isActive) {
      return;
    }

    const now = Tone.now();
    const stopAt = now + durationSeconds;

    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, stopAt);
    voice.synth.triggerRelease(stopAt);

    voice.isActive = false;
    voice.currentMidi = null;
  }

  private createVoice(): VoiceState {
    const synth = new Tone.Synth({
      oscillator: { type: 'sine' },
      envelope: { attack: 0.22, decay: 0.35, sustain: 0.85, release: 1.3 },
    });

    const gain = new Tone.Gain(0);
    synth.connect(gain);
    gain.connect(this.reverb);

    return {
      synth,
      gain,
      currentMidi: null,
      isActive: false,
      level: 0.8,
    };
  }

  private targetGain(hand: HandId): number {
    return this.presetGain * this.voices[hand].level;
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
