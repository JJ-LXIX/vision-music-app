import {
  FilesetResolver,
  HandLandmarker,
  type Category,
  type HandLandmarkerResult,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';
import type { DetectionFrame, HandId, Point2D, TrackedHand } from './types';

const TASKS_VISION_VERSION = '0.10.32';
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const WRIST_INDEX = 0;
const PALM_INDICES = [0, 5, 9, 13, 17] as const;

export class HandTracker {
  private landmarker: HandLandmarker | null = null;
  private lastVideoTime = -1;

  async init(): Promise<void> {
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE);

    try {
      this.landmarker = await this.createLandmarker(vision, 'GPU');
    } catch {
      this.landmarker = await this.createLandmarker(vision, 'CPU');
    }
  }

  detect(video: HTMLVideoElement, timestampMs: number): DetectionFrame | null | undefined {
    if (!this.landmarker || video.readyState < 2) {
      return null;
    }

    if (video.currentTime === this.lastVideoTime) {
      return undefined;
    }

    this.lastVideoTime = video.currentTime;
    const result = this.landmarker.detectForVideo(video, timestampMs);
    return extractHands(result);
  }

  private createLandmarker(
    vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
    delegate: 'GPU' | 'CPU',
  ): Promise<HandLandmarker> {
    return HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: HAND_MODEL,
        delegate,
      },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.55,
    });
  }
}

function extractHands(result: HandLandmarkerResult): DetectionFrame {
  const hands: TrackedHand[] = [];
  let usedLeft = false;
  let usedRight = false;

  for (let index = 0; index < result.landmarks.length; index += 1) {
    const landmarks = result.landmarks[index];
    if (!landmarks || landmarks.length <= WRIST_INDEX) {
      continue;
    }

    const point = getPalmCenter(landmarks);
    const handId = classifyHand(result.handedness[index], point, usedLeft, usedRight);
    if (handId === 'left') {
      usedLeft = true;
    } else {
      usedRight = true;
    }

    hands.push({ id: handId, point });
  }

  return { hands };
}

function classifyHand(
  handedness: Category[] | undefined,
  point: Point2D,
  usedLeft: boolean,
  usedRight: boolean,
): HandId {
  const label = handedness?.[0]?.categoryName?.toLowerCase();

  if (label === 'left' && !usedLeft) {
    return 'left';
  }

  if (label === 'right' && !usedRight) {
    return 'right';
  }

  if (usedLeft && !usedRight) {
    return 'right';
  }

  if (usedRight && !usedLeft) {
    return 'left';
  }

  return point.x < 0.5 ? 'left' : 'right';
}

function getPalmCenter(landmarks: NormalizedLandmark[]): Point2D {
  let x = 0;
  let y = 0;

  for (const index of PALM_INDICES) {
    const landmark = landmarks[index];
    x += landmark.x;
    y += landmark.y;
  }

  const count = PALM_INDICES.length;

  return {
    x: x / count,
    y: y / count,
  };
}
