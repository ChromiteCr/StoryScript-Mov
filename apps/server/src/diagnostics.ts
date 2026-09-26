import { H264_ENCODER_PREFERENCE, listEncoders, locateTool, toolVersion, type ToolInfo } from './adapters/media/ffmpeg.ts';

/** ffmpeg/ffprobe discovery shared by /health and `doctor`. Cached per process. */

export interface ToolsInfo {
  ffmpeg: ToolInfo;
  ffprobe: ToolInfo;
  /** available H.264 encoders, in preference order */
  h264_encoders: string[];
}

let cached: Promise<ToolsInfo> | null = null;

export function detectTools(opts: { refresh?: boolean } = {}): Promise<ToolsInfo> {
  if (!cached || opts.refresh) cached = probeTools();
  return cached;
}

async function probeTools(): Promise<ToolsInfo> {
  const ffmpegPath = locateTool('ffmpeg');
  const ffprobePath = locateTool('ffprobe');
  const [ffmpegVersion, ffprobeVersion, encoders] = await Promise.all([
    toolVersion(ffmpegPath),
    toolVersion(ffprobePath),
    listEncoders(ffmpegPath),
  ]);
  return {
    ffmpeg: { path: ffmpegPath, version: ffmpegVersion },
    ffprobe: { path: ffprobePath, version: ffprobeVersion },
    h264_encoders: H264_ENCODER_PREFERENCE.filter((e) => encoders.includes(e)),
  };
}
