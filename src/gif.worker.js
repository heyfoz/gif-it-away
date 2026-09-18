// Message shim around the encoder, so the page keeps painting its progress bar
// while the pixels get chewed through. All the real work is in gifcore.js,
// which the command line runs too.

import { createGifRun } from './gifcore.js';

let run = null;

self.onmessage = (event) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'start':
        run = createGifRun(msg.opts);
        self.postMessage({ type: 'ready' });
        break;

      case 'sample':
        run.addSample(new Uint8Array(msg.buffer));
        self.postMessage({ type: 'ack' });
        break;

      case 'buildPalette':
        self.postMessage({ type: 'paletteReady', colors: run.buildPalette() });
        break;

      case 'frame':
        run.addFrame(new Uint8Array(msg.buffer), msg.delayCs);
        self.postMessage({ type: 'ack' });
        break;

      case 'finish': {
        const { bytes, frames, reuse } = run.finish();
        run = null;
        self.postMessage({ type: 'done', buffer: bytes.buffer, frames, reuse }, [bytes.buffer]);
        break;
      }
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || String(error) });
  }
};
