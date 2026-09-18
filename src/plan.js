// Sizes and timings. No DOM, no filesystem: the page and the command line both
// work out the same frame plan from the same numbers.

/** Even numbers only: odd sizes upset some GIF viewers and every scaler on the way. */
export function even(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** Output size for a source, honouring a max width and never scaling up. */
export function outputSize(sourceWidth, sourceHeight, maxWidth) {
  const w = !maxWidth || maxWidth >= sourceWidth ? sourceWidth : maxWidth;
  const scale = w / sourceWidth;
  return { width: even(w), height: even(sourceHeight * scale), scale };
}

/**
 * How long each frame should sit on screen, in hundredths of a second.
 *
 * GIF stores delays in centiseconds, so most frame rates do not divide evenly:
 * 15fps wants 6.67cs a frame. Rounding every delay the same way would drift the
 * clip slower or faster than the source. Taking the difference between two
 * rounded cumulative times instead spreads the remainder across the run, so the
 * total length stays right and only single frames vary by 10ms.
 */
export function delaysFor(count, fps) {
  const delays = [];
  for (let i = 0; i < count; i++) {
    const cs = Math.round(((i + 1) * 100) / fps) - Math.round((i * 100) / fps);
    // A delay under 2cs is silently promoted to 10cs by a lot of viewers,
    // which would stall a fast gif instead of speeding it up.
    delays.push(Math.max(2, cs));
  }
  return delays;
}

/** Forwards, then back through the middle again. */
export function pingPongOrder(count) {
  const forward = Array.from({ length: count }, (_, i) => i);
  return count > 2 ? forward.concat(forward.slice(1, -1).reverse()) : forward;
}

/** Which source timestamps to sample, how long each lasts, and in what order. */
export function planFrames({ start, end, fps, speed = 1, pingPong = false }) {
  const span = Math.max(0, end - start);
  const count = Math.max(1, Math.round((span / speed) * fps));

  const times = [];
  for (let i = 0; i < count; i++) {
    times.push(Math.min(start + (i / fps) * speed, end));
  }

  const delays = delaysFor(count, fps);
  const order = pingPong ? pingPongOrder(count) : Array.from({ length: count }, (_, i) => i);
  const totalCs = order.reduce((sum, i) => sum + delays[i], 0);

  return {
    times,
    delays,
    order,
    frameCount: order.length,
    uniqueCount: count,
    durationSeconds: totalCs / 100,
    effectiveFps: totalCs > 0 ? order.length / (totalCs / 100) : fps,
  };
}
