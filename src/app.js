// Page wiring: pick a video, set the knobs, watch the frames go by.

import { loadVideo, seek, createSampler } from './decode.js';
import { outputSize, planFrames } from './plan.js';

const $ = (id) => document.getElementById(id);

const el = {
  drop: $('drop'), pick: $('pick'), file: $('file'), url: $('url'), urlGo: $('urlGo'),
  dropNote: $('dropNote'), workspace: $('workspace'),
  preview: $('preview'), scrub: $('scrub'), timeNow: $('timeNow'), timeTotal: $('timeTotal'),
  trimStart: $('trimStart'), trimEnd: $('trimEnd'), setStart: $('setStart'), setEnd: $('setEnd'),
  trimReset: $('trimReset'), source: $('source'),
  fps: $('fps'), maxWidth: $('maxWidth'), customWidth: $('customWidth'), colors: $('colors'),
  dither: $('dither'), paletteMode: $('paletteMode'), speed: $('speed'),
  loopMode: $('loopMode'), loopCount: $('loopCount'),
  diff: $('diff'), diffHint: $('diffHint'), pingPong: $('pingPong'), smooth: $('smooth'),
  plan: $('plan'), make: $('make'), cancel: $('cancel'), another: $('another'),
  progress: $('progress'), barFill: $('barFill'), phase: $('phase'),
  result: $('result'), meta: $('meta'), gifOut: $('gifOut'), download: $('download'),
};

const state = {
  video: null,
  name: 'video',
  objectUrl: null,
  gifUrl: null,
  previewSampler: null,
  running: false,
  cancelled: false,
};

/* ---------------------------------------------------------------- loading */

function say(message) {
  el.dropNote.textContent = message || '';
}

async function useSource(src, name, { crossOrigin = null } = {}) {
  say('');
  el.pick.disabled = true;
  el.urlGo.disabled = true;
  try {
    const video = await loadVideo(src, { crossOrigin });
    if (state.objectUrl && state.objectUrl !== src) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = src.startsWith('blob:') ? src : null;
    state.video = video;
    state.name = name;
    onVideoReady();
  } catch (error) {
    say(error.message);
  } finally {
    el.pick.disabled = false;
    el.urlGo.disabled = false;
  }
}

function acceptFile(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  useSource(url, file.name.replace(/\.[^.]+$/, ''));
}

el.pick.addEventListener('click', () => el.file.click());
el.file.addEventListener('change', () => acceptFile(el.file.files[0]));

el.urlGo.addEventListener('click', () => {
  const raw = el.url.value.trim();
  if (!raw) return;
  let parsed;
  try {
    parsed = new URL(raw, location.href);
  } catch {
    say('That does not look like a URL.');
    return;
  }
  const cross = parsed.origin !== location.origin;
  const name = decodeURIComponent(parsed.pathname.split('/').pop() || 'video').replace(/\.[^.]+$/, '');
  useSource(parsed.href, name, { crossOrigin: cross ? 'anonymous' : null });
});
el.url.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') el.urlGo.click();
});

for (const type of ['dragenter', 'dragover']) {
  el.drop.addEventListener(type, (event) => {
    event.preventDefault();
    el.drop.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) {
  el.drop.addEventListener(type, () => el.drop.classList.remove('over'));
}
el.drop.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (file) acceptFile(file);
});
// Dropping anywhere else should not navigate away from a half-set-up job.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

/* ------------------------------------------------------------- the knobs */

function readOpts() {
  const widthChoice = el.maxWidth.value;
  const maxWidth = widthChoice === 'custom'
    ? Math.max(16, Number(el.customWidth.value) || 16)
    : Number(widthChoice);

  const loopMode = el.loopMode.value;
  const repeat = loopMode === 'forever' ? 0
    : loopMode === 'once' ? -1
    : Math.max(1, Math.min(65535, Number(el.loopCount.value) || 1));

  const paletteMode = el.paletteMode.value;
  return {
    maxWidth,
    fps: Number(el.fps.value),
    colors: Number(el.colors.value),
    dither: el.dither.value,
    palette: paletteMode,
    // A shared index is what makes "same as last frame" mean anything, so
    // reuse is only on the table when there is one palette for the run.
    diff: el.diff.checked && paletteMode === 'global',
    speed: Number(el.speed.value),
    pingPong: el.pingPong.checked,
    smooth: el.smooth.checked,
    repeat,
    start: Number(el.trimStart.value) || 0,
    end: Number(el.trimEnd.value) || 0,
  };
}

const PRESETS = {
  small: { fps: '10', maxWidth: '480', colors: '64', dither: 'none', paletteMode: 'global', diff: true },
  balanced: { fps: '15', maxWidth: '800', colors: '128', dither: 'none', paletteMode: 'global', diff: true },
  high: { fps: '20', maxWidth: '0', colors: '256', dither: 'none', paletteMode: 'global', diff: true },
};

for (const button of document.querySelectorAll('[data-preset]')) {
  button.addEventListener('click', () => {
    const preset = PRESETS[button.dataset.preset];
    el.fps.value = preset.fps;
    el.maxWidth.value = preset.maxWidth;
    el.colors.value = preset.colors;
    el.dither.value = preset.dither;
    el.paletteMode.value = preset.paletteMode;
    el.diff.checked = preset.diff;
    for (const other of document.querySelectorAll('[data-preset]')) {
      other.setAttribute('aria-pressed', String(other === button));
    }
    syncFields();
    refreshPreview();
  });
}

function syncFields() {
  el.customWidth.hidden = el.maxWidth.value !== 'custom';
  el.loopCount.hidden = el.loopMode.value !== 'count';

  const perFrame = el.paletteMode.value === 'perFrame';
  el.diff.disabled = perFrame;
  el.diff.closest('.switch').classList.toggle('off', perFrame);
  el.diffHint.textContent = perFrame
    ? 'Not available with a palette per frame: the color numbers change from frame to frame, so nothing can be carried over.'
    : 'Big win on screen recordings. Needs one shared palette, and it spends one color slot.';

  updatePlan();
}

function updatePlan() {
  if (!state.video) return;
  const opts = readOpts();
  const { width, height } = outputSize(state.video.videoWidth, state.video.videoHeight, opts.maxWidth);
  const plan = planFrames(opts);

  const paletteText = opts.palette === 'global'
    ? `one palette of up to ${opts.diff ? opts.colors - 1 : opts.colors} colors`
    : `a fresh palette of up to ${opts.colors} colors on every frame`;
  const fpsText = Math.abs(plan.effectiveFps - opts.fps) < 0.05
    ? `${opts.fps} fps`
    : `${opts.fps} fps asked for, ${plan.effectiveFps.toFixed(1)} after GIF rounds the delays`;

  const megapixels = (plan.frameCount * width * height) / 1e6;
  const heavy = megapixels > 60
    ? `<br>That is ${megapixels.toFixed(0)} megapixels of work. Expect a wait, and a large file.`
    : '';

  el.plan.innerHTML = `
    <b>${width} x ${height}</b>, <b>${plan.frameCount}</b> frames, ${fpsText}.<br>
    Runs for <b>${plan.durationSeconds.toFixed(2)}s</b> with ${paletteText}.${heavy}`;
}

for (const control of [el.fps, el.maxWidth, el.colors, el.dither, el.paletteMode, el.speed, el.loopMode, el.diff, el.pingPong, el.smooth]) {
  control.addEventListener('change', () => {
    syncFields();
    if (control === el.maxWidth || control === el.smooth) refreshPreview();
  });
}
el.customWidth.addEventListener('input', () => {
  updatePlan();
  refreshPreview();
});
el.loopCount.addEventListener('input', updatePlan);

/* ------------------------------------------------------------- preview */

function clampTrim() {
  const duration = state.video.duration;
  let start = Math.max(0, Math.min(Number(el.trimStart.value) || 0, duration));
  let end = Math.max(0, Math.min(Number(el.trimEnd.value) || 0, duration));
  // Keep at least one frame's worth of clip between the handles.
  const minSpan = Math.min(0.04, duration);
  if (end <= start) end = Math.min(duration, start + minSpan);
  if (end - start < minSpan) start = Math.max(0, end - minSpan);
  el.trimStart.value = start.toFixed(2);
  el.trimEnd.value = end.toFixed(2);
  return { start, end };
}

let seekBusy = false;
let seekWant = null;

/** Coalescing seek: a drag on the scrubber queues one target, not thirty. */
async function previewAt(time) {
  seekWant = time;
  if (seekBusy || !state.video) return;
  seekBusy = true;
  try {
    while (seekWant !== null) {
      const target = seekWant;
      seekWant = null;
      await seek(state.video, target);
      el.timeNow.textContent = state.video.currentTime.toFixed(2);
      state.previewSampler?.draw(state.video);
    }
  } catch {
    /* A failed preview seek is not worth interrupting anyone over. */
  } finally {
    seekBusy = false;
  }
}

function refreshPreview() {
  if (!state.video) return;
  const opts = readOpts();
  const { width, height } = outputSize(state.video.videoWidth, state.video.videoHeight, opts.maxWidth);
  el.preview.width = width;
  el.preview.height = height;
  // The preview canvas is the output canvas, so what is on screen is the real
  // pixel grid the GIF will be made of, not a guess at it.
  state.previewSampler = {
    draw(video) {
      const ctx = el.preview.getContext('2d');
      ctx.imageSmoothingEnabled = opts.smooth;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(video, 0, 0, width, height);
    },
  };
  if (state.video.readyState >= 2) state.previewSampler.draw(state.video);
}

function onVideoReady() {
  const video = state.video;
  const duration = video.duration;

  el.workspace.hidden = false;
  el.drop.hidden = true;
  el.result.hidden = true;

  el.scrub.max = String(duration);
  el.scrub.value = '0';
  el.timeTotal.textContent = duration.toFixed(2);
  el.trimStart.value = '0';
  el.trimEnd.value = duration.toFixed(2);
  el.trimStart.max = duration.toFixed(2);
  el.trimEnd.max = duration.toFixed(2);

  el.source.textContent = `${state.name}: ${video.videoWidth} x ${video.videoHeight}, ${duration.toFixed(2)}s`;

  document.querySelector('[data-preset="balanced"]')?.click();
  syncFields();
  refreshPreview();
  previewAt(0);
}

el.scrub.addEventListener('input', () => previewAt(Number(el.scrub.value)));
el.setStart.addEventListener('click', () => {
  el.trimStart.value = state.video.currentTime.toFixed(2);
  clampTrim();
  updatePlan();
});
el.setEnd.addEventListener('click', () => {
  el.trimEnd.value = state.video.currentTime.toFixed(2);
  clampTrim();
  updatePlan();
});
el.trimReset.addEventListener('click', () => {
  el.trimStart.value = '0';
  el.trimEnd.value = state.video.duration.toFixed(2);
  updatePlan();
});
for (const field of [el.trimStart, el.trimEnd]) {
  field.addEventListener('change', () => {
    clampTrim();
    updatePlan();
  });
}

el.another.addEventListener('click', () => {
  if (state.running) return;
  el.workspace.hidden = true;
  el.drop.hidden = false;
  el.file.value = '';
  say('');
});

/* ------------------------------------------------------------- encoding */

/**
 * Strict request and reply over the worker.
 *
 * Every message sent gets exactly one back, in order, so a plain queue of
 * resolvers is enough. That also means frames can be sent a couple ahead of
 * their acknowledgements, which keeps the decoder and the encoder both busy
 * without letting more than a frame or two pile up in memory.
 */
function connect(worker) {
  const waiting = [];
  let failure = null;
  const breakAll = (error) => {
    failure = error;
    while (waiting.length) waiting.shift().reject(error);
  };
  worker.onmessage = (event) => {
    const message = event.data;
    if (message.type === 'error') {
      breakAll(new Error(message.message));
      return;
    }
    waiting.shift()?.resolve(message);
  };
  worker.onerror = (event) => breakAll(new Error(event.message || 'The encoder stopped.'));
  return {
    send(message, transfer) {
      if (failure) return Promise.reject(failure);
      const reply = new Promise((resolve, reject) => waiting.push({ resolve, reject }));
      worker.postMessage(message, transfer || []);
      return reply;
    },
  };
}

function setProgress(fraction, text) {
  el.barFill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  el.phase.textContent = text;
}

function bytesText(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

const SAMPLE_FRAMES = 16;
const SAMPLE_WIDTH = 640;

async function run() {
  const opts = readOpts();
  const { start, end } = clampTrim();
  opts.start = start;
  opts.end = end;

  const { width, height } = outputSize(state.video.videoWidth, state.video.videoHeight, opts.maxWidth);
  const plan = planFrames(opts);

  state.running = true;
  state.cancelled = false;
  el.make.disabled = true;
  el.cancel.hidden = false;
  el.progress.hidden = false;
  el.result.hidden = true;
  setProgress(0, 'Getting started');

  const worker = new Worker(new URL('./gif.worker.js', import.meta.url), { type: 'module' });
  const link = connect(worker);
  const began = performance.now();

  try {
    await link.send({ type: 'start', opts: { ...opts, width, height } });

    if (opts.palette === 'global') {
      // One palette for the run has to be decided before the first frame is
      // written, so a handful of frames spread across the clip are read first.
      // A palette is a color histogram, so a few frames at a smaller size
      // answer the same question as every frame at full size, much faster.
      const sampleWidth = Math.min(width, SAMPLE_WIDTH);
      const sampleHeight = Math.max(2, Math.round((height * sampleWidth) / width / 2) * 2);
      const sampler = createSampler(sampleWidth, sampleHeight, { smooth: opts.smooth });
      const picks = Math.min(SAMPLE_FRAMES, plan.uniqueCount);

      for (let i = 0; i < picks; i++) {
        if (state.cancelled) throw new Error('cancelled');
        const at = picks === 1 ? 0 : Math.round((i * (plan.uniqueCount - 1)) / (picks - 1));
        await seek(state.video, plan.times[at]);
        sampler.draw(state.video);
        const pixels = sampler.read();
        setProgress((i + 1) / picks * 0.18, `Reading colors: ${i + 1} of ${picks}`);
        await link.send({ type: 'sample', buffer: pixels.buffer }, [pixels.buffer]);
      }

      const built = await link.send({ type: 'buildPalette' });
      setProgress(0.2, `Palette of ${built.colors} colors`);
    }

    const sampler = createSampler(width, height, { smooth: opts.smooth });
    const inflight = [];

    for (let i = 0; i < plan.order.length; i++) {
      if (state.cancelled) throw new Error('cancelled');
      const frameIndex = plan.order[i];
      await seek(state.video, plan.times[frameIndex]);
      sampler.draw(state.video);
      const pixels = sampler.read();

      inflight.push(link.send(
        { type: 'frame', buffer: pixels.buffer, delayCs: plan.delays[frameIndex] },
        [pixels.buffer]
      ));
      // Two frames of slack: enough to keep the worker fed while the next seek
      // happens, not enough for a long clip to fill up memory.
      if (inflight.length >= 2) await inflight.shift();

      setProgress(0.2 + ((i + 1) / plan.order.length) * 0.78, `Frame ${i + 1} of ${plan.order.length}`);
    }
    await Promise.all(inflight);

    setProgress(0.99, 'Writing the file');
    const done = await link.send({ type: 'finish' });

    const bytes = new Uint8Array(done.buffer);
    const blob = new Blob([bytes], { type: 'image/gif' });
    if (state.gifUrl) URL.revokeObjectURL(state.gifUrl);
    state.gifUrl = URL.createObjectURL(blob);

    el.gifOut.src = state.gifUrl;
    el.download.href = state.gifUrl;
    el.download.download = `${state.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'out'}-${width}x${height}-${opts.fps}fps.gif`;

    const seconds = (performance.now() - began) / 1000;
    const reuseText = opts.diff && done.reuse > 0
      ? ` Reused ${(done.reuse * 100).toFixed(0)}% of pixels between frames.`
      : '';
    el.meta.innerHTML = `<b>${bytesText(blob.size)}</b>, ${width} x ${height}, `
      + `<b>${done.frames}</b> frames, ${plan.durationSeconds.toFixed(2)}s at `
      + `${plan.effectiveFps.toFixed(1)} fps. Took ${seconds.toFixed(1)}s.${reuseText}`;

    el.result.hidden = false;
    setProgress(1, 'Done');
  } catch (error) {
    if (error.message === 'cancelled') {
      setProgress(0, 'Stopped');
    } else {
      setProgress(0, `That did not work: ${error.message}`);
    }
  } finally {
    worker.terminate();
    state.running = false;
    el.make.disabled = false;
    el.cancel.hidden = true;
  }
}

el.make.addEventListener('click', () => {
  if (!state.running) run();
});
el.cancel.addEventListener('click', () => {
  state.cancelled = true;
});

/* --------------------------------------------------------------- startup */

// ?src=... loads a video straight away, which is handy for a file already
// sitting next to this page.
const fromQuery = new URLSearchParams(location.search).get('src');
if (fromQuery) {
  let parsed = null;
  try {
    parsed = new URL(fromQuery, location.href);
  } catch { /* ignored: a bad ?src just leaves the drop zone up */ }
  if (parsed) {
    el.url.value = parsed.href;
    const cross = parsed.origin !== location.origin;
    const name = decodeURIComponent(parsed.pathname.split('/').pop() || 'video').replace(/\.[^.]+$/, '');
    useSource(parsed.href, name, { crossOrigin: cross ? 'anonymous' : null });
  }
}
