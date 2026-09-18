#!/usr/bin/env node
// Same encoder as the page, driven from a terminal.
//
// The page reads frames by seeking a <video>; this reads them from ffmpeg as
// raw RGBA. Everything after that (palette, dithering, unchanged-pixel reuse,
// LZW) is src/gifcore.js, the same file the worker loads, so the options mean
// exactly what they mean in the browser.
//
// Needs ffmpeg and ffprobe on PATH.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { createGifRun } from './src/gifcore.js';
import { delaysFor, outputSize, pingPongOrder } from './src/plan.js';

const HELP = `
gif-it-to-me: turn a video into a GIF

  node cli.mjs <video> [options]

  -o, --out <file>      where to write (default: alongside the input)
      --fps <n>         frames per second (default 15)
      --width <n>       max width in pixels, 0 keeps the original (default 0)
      --colors <n>      palette size up to 256 (default 256)
      --dither <mode>   none | floyd | atkinson (default none)
      --palette <mode>  global | perFrame (default global)
      --no-diff         write every pixel instead of reusing unchanged ones
      --start <s>       trim start in seconds (default 0)
      --end <s>         trim end in seconds (default: end of the clip)
      --speed <x>       playback rate, 2 is twice as fast (default 1)
      --ping-pong       play forwards then backwards
      --loop <n>        0 forever, 1 once, or a play count (default 0)
      --samples <n>     frames read to pick the shared palette (default 16)
      --scaler <name>   ffmpeg scaler: lanczos | bicubic | bilinear | neighbor
  -q, --quiet           no progress output

Examples
  node cli.mjs clip.mov --width 800 --fps 15
  node cli.mjs clip.mov --colors 64 --dither floyd --out small.gif
`;

function parseArgs(argv) {
  const opts = {
    input: null, out: null, fps: 15, width: 0, colors: 256, dither: 'none',
    palette: 'global', diff: true, start: 0, end: null, speed: 1,
    pingPong: false, loop: 0, samples: 16, scaler: 'lanczos', quiet: false,
  };
  const numeric = {
    '--fps': 'fps', '--width': 'width', '--colors': 'colors', '--start': 'start',
    '--end': 'end', '--speed': 'speed', '--loop': 'loop', '--samples': 'samples',
  };
  const text = { '--dither': 'dither', '--palette': 'palette', '--scaler': 'scaler' };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return 'help';
    if (arg === '-q' || arg === '--quiet') { opts.quiet = true; continue; }
    if (arg === '--no-diff') { opts.diff = false; continue; }
    if (arg === '--ping-pong') { opts.pingPong = true; continue; }
    if (arg === '-o' || arg === '--out') { opts.out = argv[++i]; continue; }
    if (numeric[arg]) {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value)) throw new Error(`${arg} needs a number.`);
      opts[numeric[arg]] = value;
      continue;
    }
    if (text[arg]) { opts[text[arg]] = argv[++i]; continue; }
    if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}.`);
    if (opts.input) throw new Error('Only one input file at a time.');
    opts.input = arg;
  }

  if (!opts.input) throw new Error('Which video? Pass a file, or --help.');
  if (!['none', 'floyd', 'atkinson'].includes(opts.dither)) {
    throw new Error(`--dither has to be none, floyd or atkinson.`);
  }
  if (!['global', 'perFrame'].includes(opts.palette)) {
    throw new Error(`--palette has to be global or perFrame.`);
  }
  if (opts.palette === 'perFrame') opts.diff = false;
  opts.colors = Math.max(2, Math.min(256, Math.round(opts.colors)));
  if (!opts.out) {
    opts.out = `${basename(opts.input, extname(opts.input))}.gif`;
  }
  return opts;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', () => reject(new Error(`${command} is not on PATH.`)));
    proc.on('close', (code) => code === 0
      ? resolve(out)
      : reject(new Error(`${command} failed: ${err.trim().split('\n').slice(-3).join(' ')}`)));
  });
}

async function probe(input) {
  const raw = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration',
    '-of', 'json', input,
  ]);
  const info = JSON.parse(raw);
  const stream = info.streams?.[0];
  const duration = Number(info.format?.duration);
  if (!stream?.width || !Number.isFinite(duration)) {
    throw new Error('No video track with a readable duration in that file.');
  }
  return { width: stream.width, height: stream.height, duration };
}

/**
 * Raw RGBA frames off ffmpeg's stdout, one complete frame at a time.
 *
 * Chunks do not arrive on frame boundaries, so they are held until a whole
 * frame's worth is in hand. Each frame is copied into its own buffer because
 * the quantizer reads it as a Uint32Array of the entire ArrayBuffer, which a
 * pooled Node Buffer view would get wrong.
 */
async function* rawFrames(args, frameBytes) {
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let spawnFailed = null;
  proc.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-4000);
  });
  // Throwing from this listener would never reach whoever is iterating, so the
  // failure is held and raised at the end, where it can be seen.
  proc.on('error', () => { spawnFailed = new Error('ffmpeg is not on PATH.'); });

  let held = [];
  let heldLength = 0;
  for await (const chunk of proc.stdout) {
    held.push(chunk);
    heldLength += chunk.length;
    while (heldLength >= frameBytes) {
      const joined = held.length === 1 ? held[0] : Buffer.concat(held, heldLength);
      yield new Uint8Array(joined.subarray(0, frameBytes));
      const rest = joined.subarray(frameBytes);
      held = rest.length ? [Buffer.from(rest)] : [];
      heldLength = rest.length;
    }
  }

  const code = await new Promise((resolve) => proc.on('close', resolve));
  if (spawnFailed) throw spawnFailed;
  if (code !== 0) throw new Error(`ffmpeg failed:\n${stderr.trim()}`);
}

function extractArgs(opts, { start, span, fps, width, height, scaler }) {
  return [
    '-v', 'error', '-nostdin',
    // -ss ahead of -i seeks by keyframe first, which is what makes a trim from
    // the middle of a long file quick instead of a full decode from zero.
    '-ss', String(start), '-t', String(span), '-i', opts.input,
    '-vf', `fps=${fps},scale=${width}:${height}:flags=${scaler}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
  ];
}

function bytesText(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

async function main() {
  if (process.argv.length <= 2) {
    console.log(HELP.trim());
    process.exit(1);
  }
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  if (opts === 'help') {
    console.log(HELP.trim());
    process.exit(0);
  }

  const note = opts.quiet ? () => {} : (text) => process.stderr.write(`${text}\n`);
  const began = Date.now();

  const source = await probe(opts.input);
  const start = Math.max(0, Math.min(opts.start, source.duration));
  const end = Math.max(start, Math.min(opts.end ?? source.duration, source.duration));
  const span = Math.max(1 / 1000, end - start);
  const { width, height } = outputSize(source.width, source.height, opts.width);

  // The page samples the source at fps/speed and plays back at fps; asking
  // ffmpeg's fps filter for the same rate keeps the two in step.
  const extractFps = opts.fps / opts.speed;
  const frameBytes = width * height * 4;

  note(`${basename(opts.input)}: ${source.width}x${source.height}, ${source.duration.toFixed(2)}s`);
  note(`out: ${width}x${height} at ${opts.fps}fps, ${opts.colors} colors, dither ${opts.dither}, ${opts.palette} palette${opts.diff ? ', reusing unchanged pixels' : ''}`);

  const gif = createGifRun({
    width, height,
    colors: opts.colors,
    dither: opts.dither,
    palette: opts.palette,
    diff: opts.diff,
    repeat: opts.loop === 1 ? -1 : Math.max(0, Math.round(opts.loop)),
  });

  if (opts.palette === 'global') {
    // A palette is a color histogram, so a spread of frames at a smaller size
    // answers the same question as every frame at full size, much faster.
    const wanted = Math.max(1, Math.round(opts.samples));
    const sampleFps = Math.max(1 / span, wanted / span);
    const sampleWidth = Math.min(width, 640);
    const sampleHeight = Math.max(2, Math.round((height * sampleWidth) / width / 2) * 2);
    let seen = 0;
    for await (const frame of rawFrames(
      extractArgs(opts, { start, span, fps: sampleFps, width: sampleWidth, height: sampleHeight, scaler: opts.scaler }),
      sampleWidth * sampleHeight * 4,
    )) {
      if (seen >= wanted) break;
      gif.addSample(frame);
      seen++;
    }
    note(`palette: read ${seen} frames, kept ${gif.buildPalette()} colors`);
  }

  const frames = [];
  const stream = rawFrames(
    extractArgs(opts, { start, span, fps: extractFps, width, height, scaler: opts.scaler }),
    frameBytes,
  );

  if (opts.pingPong) {
    // Going back through the middle means every frame gets used twice, so they
    // all have to be kept.
    for await (const frame of stream) frames.push(frame);
    const delays = delaysFor(frames.length, opts.fps);
    const order = pingPongOrder(frames.length);
    for (let i = 0; i < order.length; i++) {
      gif.addFrame(frames[order[i]], delays[order[i]]);
      if (!opts.quiet && (i % 10 === 0 || i === order.length - 1)) {
        process.stderr.write(`\rframe ${i + 1} of ${order.length}`);
      }
    }
    if (!opts.quiet) process.stderr.write('\n');
  } else {
    // Delays cannot be worked out until the count is known, and only ffmpeg
    // knows how many frames `fps=` will actually produce, so the frames are
    // held and timed once the stream ends. One frame is one canvas of pixels,
    // which is the same memory the page holds while it decodes.
    for await (const frame of stream) {
      frames.push(frame);
      if (!opts.quiet && frames.length % 10 === 0) {
        process.stderr.write(`\rread ${frames.length} frames`);
      }
    }
    if (!opts.quiet) process.stderr.write('\n');
    const delays = delaysFor(frames.length, opts.fps);
    for (let i = 0; i < frames.length; i++) {
      gif.addFrame(frames[i], delays[i]);
      frames[i] = null;
      if (!opts.quiet && (i % 10 === 0 || i === frames.length - 1)) {
        process.stderr.write(`\rframe ${i + 1} of ${frames.length}`);
      }
    }
    if (!opts.quiet) process.stderr.write('\n');
  }

  const { bytes, frames: written, reuse } = gif.finish();
  writeFileSync(opts.out, bytes);

  const totalCs = delaysFor(written, opts.fps).reduce((a, b) => a + b, 0);
  note(`${opts.out}: ${bytesText(bytes.length)}, ${written} frames, ${(totalCs / 100).toFixed(2)}s`
    + `${reuse > 0 ? `, reused ${(reuse * 100).toFixed(0)}% of pixels` : ''}`
    + `, took ${((Date.now() - began) / 1000).toFixed(1)}s`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
