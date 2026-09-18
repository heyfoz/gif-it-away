// The encoder itself: frames of RGBA in, GIF89a bytes out.
//
// Nothing in here touches the DOM, a worker or the filesystem, so the page and
// the command line run the same quantizer, the same dithers and the same
// unchanged-pixel pass. Only the frame decoder differs between them.
//
// gifenc supplies two pieces: the PNN color quantizer and the LZW/GIF89a stream
// writer. The palette mapping, the error-diffusion dithers and the reuse pass
// are here, because gifenc's own applyPalette rebuilds its lookup cache on
// every call and does not dither at all.

import { GIFEncoder, quantize } from '../vendor/gifenc.esm.js';

/** rgb565 key: the same precision the quantizer binned the colors at. */
function key565(r, g, b) {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

/**
 * Nearest-palette-entry lookup, memoised across every frame of a run.
 *
 * A linear search over 256 entries for 700k pixels is 180M distance tests per
 * frame, which is seconds. The cache turns that into at most 65536 searches for
 * the whole gif, and on the second frame of a shared palette it is all hits.
 */
function makeMapper(palette) {
  const n = palette.length;
  const pr = new Int32Array(n);
  const pg = new Int32Array(n);
  const pb = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    pr[i] = palette[i][0];
    pg[i] = palette[i][1];
    pb[i] = palette[i][2];
  }
  const cache = new Int32Array(65536).fill(-1);
  return function nearest(r, g, b) {
    const k = key565(r, g, b);
    const hit = cache[k];
    if (hit >= 0) return hit;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < n; i++) {
      const dr = pr[i] - r;
      const dg = pg[i] - g;
      const db = pb[i] - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDist) {
        bestDist = d;
        best = i;
        if (d === 0) break;
      }
    }
    cache[k] = best;
    return best;
  };
}

const KERNELS = {
  // dx, dy, share of the error
  floyd: [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]],
  atkinson: [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]],
};

export const DITHERS = ['none', ...Object.keys(KERNELS)];

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Straight nearest-color mapping, no error carried between pixels. */
function mapFlat(rgba, out, nearest) {
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = nearest(rgba[p], rgba[p + 1], rgba[p + 2]);
  }
}

/**
 * Error-diffusion mapping.
 *
 * Floyd-Steinberg runs serpentine (alternating row direction), which breaks up
 * the diagonal worming a single-direction pass leaves on gradients. Atkinson
 * only passes on 6/8 of each error, which is why it stays cleaner and crunchier
 * on flat art, and why serpentining it is not worth the trouble.
 */
function mapDithered(rgba, out, nearest, palette, width, height, kernelName, err) {
  const kernel = KERNELS[kernelName];
  const serpentine = kernelName === 'floyd';
  err.fill(0);

  for (let y = 0; y < height; y++) {
    const leftToRight = !serpentine || (y & 1) === 0;
    for (let step = 0; step < width; step++) {
      const x = leftToRight ? step : width - 1 - step;
      const i = y * width + x;
      const e = i * 3;
      const p = i * 4;

      const r = clamp255(rgba[p] + err[e]);
      const g = clamp255(rgba[p + 1] + err[e + 1]);
      const b = clamp255(rgba[p + 2] + err[e + 2]);

      const idx = nearest(r, g, b);
      out[i] = idx;

      const chosen = palette[idx];
      const dr = r - chosen[0];
      const dg = g - chosen[1];
      const db = b - chosen[2];

      for (let k = 0; k < kernel.length; k++) {
        const spread = kernel[k];
        const dx = leftToRight ? spread[0] : -spread[0];
        const nx = x + dx;
        const ny = y + spread[1];
        if (nx < 0 || nx >= width || ny >= height) continue;
        const ne = (ny * width + nx) * 3;
        const w = spread[2];
        err[ne] += dr * w;
        err[ne + 1] += dg * w;
        err[ne + 2] += db * w;
      }
    }
  }
}

/** GIF's minimum LZW code size, which also sets how big a color table is written. */
function colorDepthFor(length) {
  return Math.max(2, Math.ceil(Math.log2(Math.max(2, length))));
}

/**
 * Start an encoding run.
 *
 * With `palette: 'global'`, feed a spread of frames through addSample() and
 * call buildPalette() before the first addFrame(). With `palette: 'perFrame'`,
 * go straight to addFrame().
 *
 * @param {object} opts
 * @param {number} opts.width        output width in pixels
 * @param {number} opts.height       output height in pixels
 * @param {number} opts.colors       palette size, up to 256
 * @param {'none'|'floyd'|'atkinson'} opts.dither
 * @param {'global'|'perFrame'} opts.palette
 * @param {boolean} opts.diff        write unchanged pixels as transparent
 * @param {number} opts.repeat       0 forever, -1 once, or a play count
 */
export function createGifRun(opts) {
  const { width, height, colors, dither, palette: mode, diff, repeat } = opts;
  const count = width * height;
  const encoder = GIFEncoder({ initialCapacity: 1 << 20 });

  let samples = [];
  let sampleBytes = 0;
  let palette = null;
  let writePalette = null;
  let transparentIndex = -1;
  let mapper = null;
  let err = null;
  let prev = null;
  const index = new Uint8Array(count);
  let written = 0;
  let reusedPixels = 0;
  let comparedPixels = 0;

  function choosePalette(rgba) {
    // In reuse mode one slot is spent on "same as last frame", so the picture
    // itself gets one color fewer.
    const wanted = Math.max(2, Math.min(256, diff ? colors - 1 : colors));
    palette = quantize(rgba, wanted, { format: 'rgb565' });
    mapper = makeMapper(palette);
    if (diff) {
      transparentIndex = palette.length;
      // The extra entry is never chosen: the mapper only ever sees the real
      // palette, so this slot's color is arbitrary.
      writePalette = palette.concat([[0, 0, 0]]);
    } else {
      transparentIndex = -1;
      writePalette = palette;
    }
    return palette.length;
  }

  return {
    /** Add a frame to the pool the shared palette is chosen from. */
    addSample(rgba) {
      const copy = rgba instanceof Uint8Array && rgba.byteOffset === 0 && rgba.buffer.byteLength === rgba.length
        ? rgba
        : new Uint8Array(rgba);
      samples.push(copy);
      sampleBytes += copy.length;
    },

    /** Decide the shared palette. Returns how many colors it ended up with. */
    buildPalette() {
      if (sampleBytes === 0) throw new Error('No frames were sampled for the palette.');
      const all = new Uint8Array(sampleBytes);
      let at = 0;
      for (const s of samples) {
        all.set(s, at);
        at += s.length;
      }
      samples = [];
      sampleBytes = 0;
      return choosePalette(all);
    },

    /** @param {Uint8Array} rgba width*height*4 bytes. @param {number} delayCs hundredths of a second. */
    addFrame(rgba, delayCs) {
      if (rgba.length !== count * 4) {
        throw new Error(`Frame is ${rgba.length} bytes, expected ${count * 4}.`);
      }
      if (mode === 'perFrame') choosePalette(rgba);
      if (!mapper) throw new Error('buildPalette() has to run before the first frame.');
      if (dither !== 'none' && !err) err = new Float32Array(count * 3);

      if (dither === 'none') {
        mapFlat(rgba, index, mapper);
      } else {
        mapDithered(rgba, index, mapper, palette, width, height, dither, err);
      }

      const first = written === 0;
      let useTransparency = false;

      if (diff && transparentIndex >= 0) {
        if (first) {
          prev = index.slice();
        } else {
          let reused = 0;
          for (let i = 0; i < count; i++) {
            const cur = index[i];
            if (cur === prev[i]) {
              index[i] = transparentIndex;
              reused++;
            } else {
              prev[i] = cur;
            }
          }
          reusedPixels += reused;
          comparedPixels += count;
          useTransparency = reused > 0;
        }
      }

      encoder.writeFrame(index, width, height, {
        // A local color table on every frame of a shared-palette gif would
        // waste 768 bytes a frame, so it goes in once, on the first frame.
        palette: first || mode === 'perFrame' ? writePalette : null,
        colorDepth: colorDepthFor(writePalette.length),
        delay: delayCs * 10,
        repeat: first ? repeat : undefined,
        transparent: useTransparency,
        transparentIndex: useTransparency ? transparentIndex : 0,
        // Hold the previous picture instead of clearing it, or transparent
        // pixels would show the background rather than what was already there.
        dispose: diff ? 1 : -1,
      });

      written++;
    },

    finish() {
      encoder.finish();
      const bytes = encoder.bytes();
      return {
        bytes,
        frames: written,
        reuse: comparedPixels > 0 ? reusedPixels / comparedPixels : 0,
      };
    },
  };
}
