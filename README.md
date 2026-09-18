# gif it to me

Turn a video into a GIF, in a browser tab. Nothing is uploaded: the file is read
off the local disk, the frames are decoded by the browser and the GIF is built
in a worker.

There is also a command line front end that runs the same encoder, for when you
want the file on disk without clicking anything.

## Running it

On a Mac, without a terminal: **double-click "GIF it to me" in Applications.**
It starts the server, opens the page and gets out of the way. You can also drop
videos straight onto its icon, or in the Dock, to convert them with a preset.

If the app is not built yet, or the project folder moved:

```bash
sh mac/make-app.sh
```

Or run it by hand:

```bash
npm start
```

Then open <http://localhost:5199/>, and drop a video on the page.

The server is 90 lines of `node:http` with no dependencies. It exists for two
reasons that `file://` and the usual one-line static servers cannot cover:

- ES modules and module workers are blocked on `file://` by every browser.
- `<video>` seeking needs HTTP range requests. Without `206` replies the browser
  can only play forward from the start, so the decoder stalls on the first seek.
  `python -m http.server` does not answer ranges.

## Options

| Option | What it does |
| --- | --- |
| **Start / End** | Trim. `Set here` takes the scrubber's current position. |
| **Frames per second** | 5 to 50. |
| **Width** | Max width in pixels, or the original. Height follows, and nothing is ever scaled up. |
| **Colors** | Palette size, up to GIF's limit of 256. |
| **Dithering** | Off, Floyd-Steinberg (serpentine) or Atkinson. |
| **Palette** | One palette for the whole GIF, or a fresh one per frame. |
| **Speed** | 0.25x to 4x. Faster takes fewer frames from the same stretch of video. |
| **Looping** | Forever, once, or a set number of plays. |
| **Reuse pixels that did not change** | Writes unchanged pixels as transparent. |
| **Play forwards then backwards** | Ping pong. |
| **Smooth when shrinking** | Off keeps pixel art and small text hard edged. |

The preview canvas is the output canvas, so what is on screen is the real pixel
grid the GIF gets made of, not a guess at it.

### What to reach for

- **Screen recordings and UI:** dithering off, one shared palette, reuse on.
  Flat color and text quantize cleanly, and a mostly still picture reuses most
  of its pixels. On a 5 second 1270x954 capture the reuse pass matched 94% of
  pixels between frames.
- **Photographic or heavily shaded footage:** try Floyd-Steinberg at 128 colors
  or fewer, where banding is the thing worth spending file size on.
- **Cuts and scene changes:** a palette per frame. It costs a 768 byte color
  table per frame and rules out pixel reuse, but no single palette can cover two
  unrelated scenes.

Dithering is not a quality setting that only goes up. It hides banding by adding
noise, and that noise costs both fidelity against the source and compression.
Measured on the capture above, at 1024x770 and 20fps:

| Settings | Size | SSIM | PSNR |
| --- | --- | --- | --- |
| 256 colors, no dither, one palette | 6.04 MB | 0.9909 | 46.6 dB |
| 256 colors, Atkinson | 8.18 MB | 0.9873 | 45.6 dB |
| 256 colors, Floyd-Steinberg | 9.87 MB | 0.9806 | 43.7 dB |
| 256 colors, palette per frame | 8.13 MB | 0.9903 | 46.4 dB |
| 128 colors, no dither, one palette | 4.68 MB | 0.9866 | 44.3 dB |

At 256 colors this footage has no banding left for a dither to fix, so it only
pays the cost. On a gradient at 32 colors the order flips.

## The Mac app

`mac/make-app.sh` builds "GIF it to me.app" into `/Applications`, or
`~/Applications` if that is not writable. Everything it uses ships with macOS:
`osacompile` for the bundle, `iconutil` for the icon, `plutil` for the plist. No
Xcode, no signing certificate, no dependencies. Built locally it carries no
quarantine flag, so it opens without a Gatekeeper warning.

- **Double-click** starts the server if it is not already up, waits for it to
  answer, and opens the page in your default browser.
- **Drop videos on it** and it asks for a preset, then writes a GIF next to each
  video and reveals it in the Finder. It never writes over a GIF that is already
  there: the second one becomes `clip 2.gif`.
- The server **stops itself after two hours** of nobody asking it for anything.
  Nothing is needed once the page has loaded, since the conversion is all in the
  browser, so this just keeps a stray node process out of your process list. It
  also means a bookmark to `localhost:5199` will go stale: open the app instead.

The app stores the project's absolute path, so **re-run `mac/make-app.sh` if you
move the folder**. It says so in a dialog rather than failing quietly.

### Why the app needs to hunt for node

A GUI app is launched by launchd, not by a shell, so it never reads `.zshrc` and
starts with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. Homebrew is not on that path.
Neither is nvm, which is not a directory of binaries at all but a shell
function. So to a double-clicked app, `node` and `ffmpeg` simply do not exist.

`mac/find-tools.sh` goes looking: the usual Homebrew and MacPorts prefixes,
then `PATH` in case it was run from a real shell, then the per-version
directories that nvm, fnm and asdf keep, newest first by version order rather
than by name so v9 does not beat v10.

| File | |
| --- | --- |
| `mac/make-app.sh` | Builds and installs the app. |
| `mac/app.applescript` | `on run` and `on open`, and nothing else. |
| `mac/open-page.sh` | Start the server if needed, open the browser. |
| `mac/convert-dropped.sh` | Convert one file, pick a free name, reveal it. |
| `mac/find-tools.sh` | Locate node and ffmpeg. |
| `mac/make-icon.mjs` | Draw the icon as PNGs for `iconutil`. |

The shell scripts are the app's whole implementation and each runs fine from a
terminal too, which is how they were tested: with an emptied environment and a
bare `PATH`, the way the app really sees the world.

## Command line

Same encoder, frames read from ffmpeg instead of a `<video>`. Needs `ffmpeg` and
`ffprobe` on `PATH`.

```bash
node cli.mjs clip.mov --width 800 --fps 15
node cli.mjs clip.mov --colors 64 --dither floyd --out small.gif
node cli.mjs --help
```

Output is not byte for byte identical to the page's. Everything from the palette
onward is the same code, but ffmpeg scales with lanczos and a canvas scales with
whatever the browser does, so the frames going in differ slightly.

## How it works

```
video ──┬─ browser: seek a <video>, drawImage to a canvas, getImageData
        └─ cli:     ffmpeg -f rawvideo -pix_fmt rgba
                              │
                              ▼
                     src/gifcore.js
       quantize → map to palette (± dither) → reuse unchanged pixels → LZW
                              │
                              ▼
                        GIF89a bytes
```

| File | |
| --- | --- |
| `src/gifcore.js` | The encoder. No DOM, no filesystem. |
| `src/plan.js` | Output sizes and frame timings. |
| `src/decode.js` | Browser side: load a video, seek it, read pixels. |
| `src/gif.worker.js` | 40 line message shim around `gifcore`. |
| `src/app.js` | Page wiring. |
| `cli.mjs` | Terminal front end. |
| `serve.mjs` | Static server with range support and an idle timeout. |
| `mac/` | The Mac app, and the scripts it is made of. |
| `vendor/gifenc.esm.js` | [gifenc](https://github.com/mattdesl/gifenc) 1.0.3, MIT. |

Frames are decoded one at a time and handed to the worker two ahead of their
acknowledgements, so the decoder and the encoder both stay busy without a long
clip filling up memory.

### Details worth knowing

**Delays are stored in hundredths of a second.** 15fps wants 6.67cs a frame.
Rounding every delay the same way would drift the clip slower or faster than the
source, so each delay is the difference between two rounded cumulative times.
That spreads the remainder across the run: the total length stays right and only
single frames vary by 10ms. 20, 25 and 50fps divide evenly and need none of this.
The page shows the effective rate when it differs from the one asked for.

**Reusing unchanged pixels is index comparison, not pixel comparison.** A pixel
whose palette index matches the previous frame's is written as the transparent
index with disposal set to "do not dispose", so the previous picture shows
through. Comparing indices rather than source pixels guarantees the result is
identical to what a full frame would have drawn. It needs one shared palette,
because per-frame palettes renumber the colors, and it spends one of the 256
slots on transparency.

**The palette comes from a sample.** A palette is a color histogram, so 16
frames spread across the clip at up to 640 wide answer the same question as
every frame at full size, much faster.

**The nearest-color lookup is memoised on an rgb565 key** across the whole run,
which is the precision the quantizer binned at anyway. Without it, a linear
search over 256 entries for 700k pixels is 180M distance tests per frame.

## Browser support

Needs module workers and `canvas.getImageData`: Chrome 80+, Safari 15+,
Firefox 114+. Whatever the browser can play in a `<video>`, this can convert.
MOV with H.264 works in Chrome and Safari.
