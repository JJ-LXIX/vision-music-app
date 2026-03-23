import "./style.css";
import { AudioEngine } from "./audioEngine";
import { HandTracker } from "./handTracker";
import {
  buildScaleNotes,
  clamp,
  quantizePitchToMidi,
  toPitchValue,
} from "./music";
import type { AppSettings, HandId, Point2D, SynthPresetName } from "./types";

const INACTIVITY_MS = 5000;
const MOVEMENT_THRESHOLD = 0.006;
const NOTE_CHANGE_MIN_INTERVAL_MS = 85;
const NOTE_CHANGE_MIN_SEMITONES = 2;

interface HandRuntimeState {
  hasHand: boolean;
  smoothedPoint: Point2D | null;
  previousPoint: Point2D | null;
  lastSignificantMotionAt: number;
  currentMidi: number | null;
  lastMidiChangeAt: number;
}

const app = requireElement<HTMLDivElement>("#app");

app.innerHTML = `
  <main class="layout">
    <section class="stage-shell">
      <div class="stage-16x9">
        <canvas id="viz"></canvas>
        <video id="camera" autoplay muted plays inline></video>
      </div>
    </section>
    <aside class="controls">
      <h1>Vision Music</h1>
      <label>
        Scale
        <select id="scale-select">
          <option value="pentatonic">Pentatonic</option>
          <option value="major">Major</option>
        </select>
      </label>
      <label>
        Sensitivity
        <input id="sensitivity" type="range" min="0.5" max="2" step="0.01" value="1" />
        <output id="sensitivity-value">1.00</output>
      </label>
      <label>
        Smoothing
        <input id="smoothing" type="range" min="0.5" max="0.96" step="0.01" value="0.87" />
        <output id="smoothing-value">0.87</output>
      </label>
      <label>
        Left Hand Synth
        <select id="left-preset-select">
          <option value="calm-air" selected>Calm Air</option>
          <option value="warm-pad">Warm Pad</option>
          <option value="glass">Glass</option>
          <option value="ethereal">Ethereal</option>
        </select>
      </label>
      <label>
        Right Hand Synth
        <select id="right-preset-select">
          <option value="calm-air">Calm Air</option>
          <option value="warm-pad">Warm Pad</option>
          <option value="glass">Glass</option>
          <option value="ethereal" selected>Ethereal</option>
        </select>
      </label>
      <label>
        Master Volume
        <input id="master-volume" type="range" min="0" max="1" step="0.01" value="0.80" />
        <output id="master-volume-value">0.80</output>
      </label>
      <label>
        Left Hand Volume
        <input id="left-volume" type="range" min="0" max="1" step="0.01" value="0.80" />
        <output id="left-volume-value">0.80</output>
      </label>
      <label>
        Right Hand Volume
        <input id="right-volume" type="range" min="0" max="1" step="0.01" value="0.80" />
        <output id="right-volume-value">0.80</output>
      </label>
      <button id="audio-btn" class="audio-btn" type="button">Enable Audio</button>
      <p id="status-line" class="status-line"></p>
    </aside>
  </main>
`;

const canvas = requireElement<HTMLCanvasElement>("#viz");
const video = requireElement<HTMLVideoElement>("#camera");
const audioBtn = requireElement<HTMLButtonElement>("#audio-btn");
const statusLine = requireElement<HTMLParagraphElement>("#status-line");
const scaleSelect = requireElement<HTMLSelectElement>("#scale-select");
const sensitivitySlider = requireElement<HTMLInputElement>("#sensitivity");
const smoothingSlider = requireElement<HTMLInputElement>("#smoothing");
const leftPresetSelect = requireElement<HTMLSelectElement>("#left-preset-select");
const rightPresetSelect = requireElement<HTMLSelectElement>("#right-preset-select");
const masterVolumeSlider = requireElement<HTMLInputElement>("#master-volume");
const leftVolumeSlider = requireElement<HTMLInputElement>("#left-volume");
const rightVolumeSlider = requireElement<HTMLInputElement>("#right-volume");
const sensitivityValue =
  requireElement<HTMLOutputElement>("#sensitivity-value");
const smoothingValue = requireElement<HTMLOutputElement>("#smoothing-value");
const masterVolumeValue = requireElement<HTMLOutputElement>(
  "#master-volume-value",
);
const leftVolumeValue = requireElement<HTMLOutputElement>("#left-volume-value");
const rightVolumeValue = requireElement<HTMLOutputElement>(
  "#right-volume-value",
);
const ctx = require2DContext(canvas);

const audio = new AudioEngine();
const tracker = new HandTracker();

const settings: AppSettings = {
  scale: "pentatonic",
  sensitivity: 1,
  smoothing: 0.87,
  leftPreset: "calm-air",
  rightPreset: "ethereal",
  masterVolume: 0.8,
  leftVolume: 0.8,
  rightVolume: 0.8,
};

let scaleNotes = buildScaleNotes(settings.scale);
const handState: Record<HandId, HandRuntimeState> = {
  left: {
    hasHand: false,
    smoothedPoint: null,
    previousPoint: null,
    lastSignificantMotionAt: performance.now(),
    currentMidi: null,
    lastMidiChangeAt: 0,
  },
  right: {
    hasHand: false,
    smoothedPoint: null,
    previousPoint: null,
    lastSignificantMotionAt: performance.now(),
    currentMidi: null,
    lastMidiChangeAt: 0,
  },
};

let isAudioEnabled = false;
let cameraReady = false;
let trackerReady = false;
let cameraError: string | null = null;
let trackerError: string | null = null;

const cameraConstraints: MediaStreamConstraints = {
  video: {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 60, min: 30 },
  },
  audio: false,
};

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }

  return element as T;
}

function require2DContext(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = target.getContext("2d");
  if (!context) {
    throw new Error("Unable to get 2D context");
  }

  return context;
}

function setStatusLine(): void {
  if (cameraError) {
    statusLine.textContent = cameraError;
    return;
  }

  if (trackerError) {
    statusLine.textContent = trackerError;
    return;
  }

  if (!cameraReady || !trackerReady) {
    statusLine.textContent = "Initializing camera and hand tracker...";
    return;
  }

  if (!isAudioEnabled) {
    statusLine.textContent = "Click Enable Audio (or tap/click page once)";
    return;
  }

  statusLine.textContent = "";
}

function resizeCanvasToDisplaySize(): void {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.floor(canvas.clientWidth * dpr);
  const height = Math.floor(canvas.clientHeight * dpr);

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function drawVideoBackground(width: number, height: number): void {
  if (
    !cameraReady ||
    video.readyState < 2 ||
    video.videoWidth === 0 ||
    video.videoHeight === 0
  ) {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#0f1722");
    gradient.addColorStop(1, "#1c2838");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    return;
  }

  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = width / height;

  let cropWidth = sourceWidth;
  let cropHeight = sourceHeight;

  if (sourceAspect > targetAspect) {
    cropWidth = sourceHeight * targetAspect;
  } else {
    cropHeight = sourceWidth / targetAspect;
  }

  const cropX = (sourceWidth - cropWidth) * 0.5;
  const cropY = (sourceHeight - cropHeight) * 0.5;

  ctx.save();
  ctx.translate(width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(
    video,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    0,
    0,
    width,
    height,
  );
  ctx.restore();

  ctx.fillStyle = "rgba(5, 10, 20, 0.18)";
  ctx.fillRect(0, 0, width, height);
}

function drawHandMarker(
  point: Point2D,
  width: number,
  height: number,
  fill: string,
  stroke: string,
): void {
  const px = (point.x + 1) * 0.5 * width;
  const py = (1 - (point.y + 1) * 0.5) * height;

  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(px, py, Math.max(6, width * 0.008), 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = stroke;
  ctx.lineWidth = Math.max(2, width * 0.004);
  ctx.beginPath();
  ctx.arc(px, py, Math.max(14, width * 0.022), 0, Math.PI * 2);
  ctx.stroke();
}

function drawScene(): void {
  resizeCanvasToDisplaySize();

  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);

  drawVideoBackground(width, height);

  const leftPoint = handState.left.smoothedPoint;
  if (handState.left.hasHand && leftPoint) {
    drawHandMarker(
      leftPoint,
      width,
      height,
      "rgba(120, 245, 210, 0.92)",
      "rgba(120, 245, 210, 0.45)",
    );
  }

  const rightPoint = handState.right.smoothedPoint;
  if (handState.right.hasHand && rightPoint) {
    drawHandMarker(
      rightPoint,
      width,
      height,
      "rgba(72, 214, 172, 0.9)",
      "rgba(72, 214, 172, 0.45)",
    );
  }
}

function movementMagnitude(a: Point2D | null, b: Point2D | null): number {
  if (!a || !b) {
    return Infinity;
  }

  return Math.hypot(a.x - b.x, a.y - b.y);
}

function toNormalized(point: Point2D): Point2D {
  const mirroredX = 1 - point.x;
  return {
    x: clamp((mirroredX - 0.5) * 2, -1, 1),
    y: clamp((0.5 - point.y) * 2, -1, 1),
  };
}

function smoothMidiChoice(
  state: HandRuntimeState,
  candidateMidi: number,
  now: number,
): number {
  if (state.currentMidi === null) {
    state.currentMidi = candidateMidi;
    state.lastMidiChangeAt = now;
    return candidateMidi;
  }

  const delta = Math.abs(candidateMidi - state.currentMidi);
  if (
    delta < NOTE_CHANGE_MIN_SEMITONES &&
    now - state.lastMidiChangeAt < NOTE_CHANGE_MIN_INTERVAL_MS
  ) {
    return state.currentMidi;
  }

  if (candidateMidi !== state.currentMidi) {
    state.currentMidi = candidateMidi;
    state.lastMidiChangeAt = now;
  }

  return state.currentMidi;
}

async function startCamera(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia(cameraConstraints);
  video.srcObject = stream;
  await video.play();
}

async function ensureAudioStarted(): Promise<void> {
  if (isAudioEnabled) {
    return;
  }

  await audio.start();
  audio.setHandPreset("left", settings.leftPreset);
  audio.setHandPreset("right", settings.rightPreset);
  audio.setMasterVolume(settings.masterVolume);
  audio.setHandVolume("left", settings.leftVolume);
  audio.setHandVolume("right", settings.rightVolume);
  isAudioEnabled = true;
  audioBtn.textContent = "Audio Enabled";
  audioBtn.disabled = true;
  setStatusLine();
}

function wireControls(): void {
  scaleSelect.addEventListener("change", () => {
    settings.scale = scaleSelect.value === "major" ? "major" : "pentatonic";
    scaleNotes = buildScaleNotes(settings.scale);
  });

  sensitivitySlider.addEventListener("input", () => {
    settings.sensitivity = Number(sensitivitySlider.value);
    sensitivityValue.textContent = settings.sensitivity.toFixed(2);
  });

  smoothingSlider.addEventListener("input", () => {
    settings.smoothing = Number(smoothingSlider.value);
    smoothingValue.textContent = settings.smoothing.toFixed(2);
  });

  leftPresetSelect.addEventListener("change", () => {
    const value = leftPresetSelect.value as SynthPresetName;
    settings.leftPreset = value;
    audio.setHandPreset("left", value);
  });

  rightPresetSelect.addEventListener("change", () => {
    const value = rightPresetSelect.value as SynthPresetName;
    settings.rightPreset = value;
    audio.setHandPreset("right", value);
  });

  masterVolumeSlider.addEventListener("input", () => {
    settings.masterVolume = Number(masterVolumeSlider.value);
    masterVolumeValue.textContent = settings.masterVolume.toFixed(2);
    audio.setMasterVolume(settings.masterVolume);
  });

  leftVolumeSlider.addEventListener("input", () => {
    settings.leftVolume = Number(leftVolumeSlider.value);
    leftVolumeValue.textContent = settings.leftVolume.toFixed(2);
    audio.setHandVolume("left", settings.leftVolume);
  });

  rightVolumeSlider.addEventListener("input", () => {
    settings.rightVolume = Number(rightVolumeSlider.value);
    rightVolumeValue.textContent = settings.rightVolume.toFixed(2);
    audio.setHandVolume("right", settings.rightVolume);
  });

  audioBtn.addEventListener("click", () => {
    void ensureAudioStarted();
  });

  window.addEventListener(
    "pointerdown",
    () => {
      void ensureAudioStarted();
    },
    { once: true },
  );

  window.addEventListener(
    "keydown",
    () => {
      void ensureAudioStarted();
    },
    { once: true },
  );
}

function handleHandUpdate(
  hand: HandId,
  rawPoint: Point2D | null,
  now: number,
): void {
  const state = handState[hand];

  if (!rawPoint) {
    state.hasHand = false;
    state.smoothedPoint = null;
    state.previousPoint = null;
    state.currentMidi = null;
    return;
  }

  state.hasHand = true;
  const normalized = toNormalized(rawPoint);

  if (!state.smoothedPoint) {
    state.smoothedPoint = normalized;
  } else {
    const alpha = 1 - settings.smoothing;
    state.smoothedPoint = {
      x: state.smoothedPoint.x + (normalized.x - state.smoothedPoint.x) * alpha,
      y: state.smoothedPoint.y + (normalized.y - state.smoothedPoint.y) * alpha,
    };
  }

  const movement = movementMagnitude(state.smoothedPoint, state.previousPoint);
  if (movement > MOVEMENT_THRESHOLD) {
    state.lastSignificantMotionAt = now;
  }

  state.previousPoint = state.smoothedPoint;
}

function processAudioForHand(hand: HandId, now: number): void {
  const state = handState[hand];
  const activeMotion =
    state.hasHand && now - state.lastSignificantMotionAt <= INACTIVITY_MS;

  if (!isAudioEnabled) {
    return;
  }

  if (state.hasHand && state.smoothedPoint && activeMotion) {
    const pitchValue = toPitchValue(
      state.smoothedPoint.x,
      state.smoothedPoint.y,
      settings.sensitivity,
    );
    const candidateMidi = quantizePitchToMidi(pitchValue, scaleNotes);
    const smoothedMidi = smoothMidiChoice(state, candidateMidi, now);
    audio.playMidi(hand, smoothedMidi);
    return;
  }

  audio.fadeOutAndStop(hand, 2.5);
}

function loop(): void {
  const now = performance.now();

  if (cameraReady && trackerReady) {
    try {
      const detection = tracker.detect(video, now);
      if (detection !== undefined && detection !== null) {
        const left =
          detection.hands.find((hand) => hand.id === "left")?.point ?? null;
        const right =
          detection.hands.find((hand) => hand.id === "right")?.point ?? null;
        handleHandUpdate("left", left, now);
        handleHandUpdate("right", right, now);
      }
    } catch (error) {
      trackerReady = false;
      trackerError = `Tracker runtime failed (${String(error)})`;
      setStatusLine();
    }
  }

  processAudioForHand("left", now);
  processAudioForHand("right", now);

  drawScene();
  requestAnimationFrame(loop);
}

async function bootstrap(): Promise<void> {
  wireControls();
  setStatusLine();
  requestAnimationFrame(loop);

  try {
    await startCamera();
    cameraReady = true;
  } catch (error) {
    cameraError = `Camera failed (${String(error)})`;
    console.error("Camera start failed:", error);
  }

  setStatusLine();

  try {
    await tracker.init();
    trackerReady = true;
  } catch (error) {
    trackerError = "Tracking unavailable (model/network/GPU issue)";
    console.error("Tracker init failed:", error);
  }

  setStatusLine();
}

void bootstrap();
