// Pulling frames out of a video, one seek at a time.
//
// There is a faster route (WebCodecs) and a lazier one (play it and grab
// whatever requestVideoFrameCallback hands you). Seeking is picked here because
// it is the only one that is both deterministic and format-agnostic: whatever
// the browser can play, this can sample, and frame 40 of a run is always the
// same pixels as frame 40 of the run before it.
//
// Sizes and frame timings live in plan.js, which the command line shares.

/** Load a video element and wait until its dimensions and duration are known. */
export function loadVideo(src, { crossOrigin = null } = {}) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    if (crossOrigin) video.crossOrigin = crossOrigin;

    const done = () => {
      cleanup();
      // Some containers report Infinity until enough of the file is buffered.
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        reject(new Error('That file has no readable duration.'));
        return;
      }
      if (!video.videoWidth || !video.videoHeight) {
        reject(new Error('That file has no video track this browser can show.'));
        return;
      }
      resolve(video);
    };
    const fail = () => {
      cleanup();
      const code = video.error?.code;
      reject(new Error(
        code === 4
          ? 'This browser cannot decode that video. Try an MP4, a MOV with H.264, or a WebM.'
          : 'The video could not be loaded.'
      ));
    };
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('durationchange', onMeta);
      video.removeEventListener('error', fail);
    };
    const onMeta = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) done();
    };

    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('durationchange', onMeta);
    video.addEventListener('error', fail);
    video.src = src;
    video.load();
  });
}

/**
 * Seek and wait for the picture to actually be the frame at `t`.
 *
 * Two traps here. Setting currentTime to the value it already holds fires no
 * `seeked` event at all, so an un-guarded await hangs forever. And a seek past
 * the last sample can land short, so callers clamp the end themselves.
 */
export function seek(video, t) {
  const target = Math.max(0, Math.min(t, Math.max(0, video.duration - 1e-3)));
  if (Math.abs(video.currentTime - target) < 1e-4 && video.readyState >= 2) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      // A stalled seek is recoverable: the caller gets whatever is on screen.
      resolve();
    }, 10000);
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error(`Seek to ${target.toFixed(3)}s failed.`)); };
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', ok);
      video.removeEventListener('error', bad);
    };
    video.addEventListener('seeked', ok, { once: true });
    video.addEventListener('error', bad, { once: true });
    video.currentTime = target;
  });
}

/** A reusable canvas that draws the video at output size and hands back pixels. */
export function createSampler(width, height, { smooth = true } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  ctx.imageSmoothingEnabled = smooth;
  ctx.imageSmoothingQuality = 'high';
  return {
    canvas,
    width,
    height,
    draw(video) {
      ctx.drawImage(video, 0, 0, width, height);
    },
    /** Returns a fresh buffer each call, ready to transfer to a worker. */
    read() {
      try {
        return ctx.getImageData(0, 0, width, height).data;
      } catch {
        throw new Error('This video is served from another site without permission to read its pixels. Download it first, then drop the file in.');
      }
    },
  };
}
