import type { BoardCamera, FrameFormat } from '@storyscript/contracts';
import { poseTopY, project, unprojectAtDepth } from '../../src/index.ts';

/** Height where the frame ray through (0.5, fy) crosses the vertical line x = 0, z = zLine. */
export function rayHeightAt(cam: BoardCamera, aspect: FrameFormat, fy: number, zLine: number): number {
  const p = unprojectAtDepth(cam, aspect, 0.5, fy, 1);
  const dir = [p[0] - cam.x, p[1] - cam.y, p[2] - cam.z] as const;
  const t = (zLine - cam.z) / dir[2];
  return cam.y + dir[1] * t;
}

/** World range visible between the frame's top and bottom edges on the subject's vertical axis. */
export function visibleRangeAt(cam: BoardCamera, aspect: FrameFormat, zLine: number): { top: number; bottom: number } {
  return { top: rayHeightAt(cam, aspect, 0, zLine), bottom: rayHeightAt(cam, aspect, 1, zLine) };
}

/** Projected feet / head-top in frame units for a subject standing at (x, z). */
export function subjectSpan(cam: BoardCamera, aspect: FrameFormat, x: number, z: number, height: number, pose: Parameters<typeof poseTopY>[0] = 'stand') {
  const head = project(cam, aspect, [x, poseTopY(pose) * height, z]);
  const foot = project(cam, aspect, [x, 0, z]);
  return { head, foot, h: foot.y - head.y };
}
