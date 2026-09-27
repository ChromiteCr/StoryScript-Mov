/**
 * A poster frame from a local video, in the browser: object URL → <video>,
 * seek, draw into a canvas, JPEG. Codecs this browser cannot decode (ProRes;
 * HEVC without hardware support) give null, like a clip without a poster.
 */

export const POSTER_WIDTH = 480;
const QUALITY = 0.82;

export function grabPoster(file: File, atSeconds: number, timeoutMs = 8000): Promise<Blob | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let settled = false;
    const done = (blob: Blob | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(blob);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    video.addEventListener('error', () => done(null));
    video.addEventListener('loadedmetadata', () => {
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      video.currentTime = Math.max(0, Math.min(atSeconds, Math.max(0, d - 0.05)));
    });
    video.addEventListener('seeked', () => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return done(null);
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(POSTER_WIDTH, w);
      canvas.height = Math.max(2, Math.round((canvas.width * h) / w / 2) * 2);
      const ctx = canvas.getContext('2d');
      if (!ctx) return done(null);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => done(b), 'image/jpeg', QUALITY);
    });
    video.src = url;
  });
}
