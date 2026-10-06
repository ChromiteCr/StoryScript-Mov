// Public surface of core/board (explicit, to keep the package namespace small).
export {
  aspectValue,
  cameraBasis,
  framingBand,
  hFov,
  horizonLine,
  LENS_MM,
  NEAR_M,
  pickFocal,
  project,
  projectPoint,
  projectPolygon,
  REF_HEIGHT_M,
  sensorHeight,
  SENSOR_W_MM,
  solveBand,
  solveCamera,
  toCamera,
  unprojectAtDepth,
  unprojectToPlane,
  vFov,
  visibleHeight,
  type CameraBasis,
  type CameraSolution,
  type FocalSource,
  type Projected,
  type SolveCameraOptions,
} from './camera.ts';
export {
  DEPTH_FACTOR,
  FACING_REL,
  inferTemplate,
  isEnvProp,
  layoutBoard,
  PROP_SIZE,
  relativeYaw,
  SCREEN_X,
  worldXAtFrameX,
  yawForRel,
  yawLookAt,
  type LayoutContext,
  type RosterEntry,
} from './layout.ts';
export {
  buildPuppet,
  effectiveGesture,
  facingBucket,
  gestureCount,
  POSE_TABLES,
  poseTopY,
  VIEW_ANGLE,
  type PuppetShape,
  type PuppetView,
} from './puppets.ts';
export { buildFrameScene, frameSize, FRAME_W, type FrameScene } from './scene.ts';
export { arrowWorldHeights, placeArrow, type ArrowPlacement } from './overlay-geom.ts';
export { renderBoard, renderPuppetPreview, RENDERER_VERSION, subjectFrameBoxes, subjectFramePoints, type RenderOptions } from './render.ts';
export { lintBoard, type BoardLintIssue, type LintOptions } from './lint.ts';
export { PENCIL_VERSION, PICTURE_VERSION, renderPencil, structureHash, type PencilRenderOptions } from './pencil.ts';
export {
  DEFAULT_PENCIL_LOOK,
  DEFAULT_PENCIL_VARIANT,
  paperLevel,
  PENCIL_VARIANTS,
  resolvePencilLook,
  type PencilLook,
  type PencilVariant,
} from './pencil-look.ts';
export { BAND_TONE, buildPencilPlan, groundTone, subjectBands, type DepthBand, type PencilPlan, type PencilSubjectInfo } from './pencil-plan.ts';
export { renderSubjectMask, renderToneMap, type SubjectMaskOptions } from './pencil-masks.ts';
export {
  dilate,
  erode,
  l1ToneClusters,
  l2MaxSaturation,
  l3SilhouetteIoU,
  l4DepthOrder,
  l5HatchDirection,
  l6ForegroundPaper,
  l7LineWidthCV,
  LOOK_THRESHOLDS,
  luminance,
  maskArea,
  maskFrom,
  meanIn,
  otsu,
  type DepthOrder,
  type HatchDirection,
  type LineWidths,
  type Mask,
  type RgbaImage,
  type SilhouetteIoU,
  type ToneClusters,
} from './look-metrics.ts';
export {
  shotFields,
  standardBoard,
  STANDARD_LOOK,
  STANDARD_ROSTER,
  STANDARD_SHOTS,
  VARIETY_SHOTS,
  STANDARD_SIDES,
  subject as standardSubject,
  type StandardShot,
} from './fixtures/standard-shots.ts';
export { measureLook, type LookReport, type Rasterize } from './look-report.ts';
