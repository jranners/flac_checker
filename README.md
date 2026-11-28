# TrueFLAC

**TrueFLAC** is a 100% client-side, privacy-first forensic audio quality analyzer built with React, TypeScript, Vite, and Tailwind CSS. It inspects audio container integrity and spectral content directly inside your browser to detect lossy transcodes (such as MP3, AAC, or Opus files upconverted to FLAC or WAV) with zero server uploads.

## Key Capabilities

- **Multi-Feature Spectral Forensics (`src/dsp/`):**
  - Pure-TypeScript Radix-2 FFT (`N = 4096` / `8192`) running in a dedicated Web Worker (with automatic chunked main-thread fallback).
  - Adaptive transient-guided segment selection (6–8 highest-transient 4-second windows) and multi-percentile spectral envelopes (**Mean**, **Median P50**, and **P95**).
  - High-frequency content gating (`8–13 kHz` vs. `1–5 kHz`) to prevent false positives on acoustic, vintage, or classical recordings.
  - Brickwall cliff slope, dead-zone floor, and temporal variance collapse analysis alongside subtle transcode fingerprints: psychoacoustic spectral holes ("Swiss cheese"), LAME `sfb21` 16 kHz shelves, high-frequency stereo collapse, raw 24-bit WAV zero-padding detection, and Hi-Res upsample detection (`UPSAMPLED_LOSSLESS`).
- **Interactive Visualizations:**
  - Retina HiDPI Magma/Inferno spectrogram with cutoff overlay and interactive crosshair telemetry.
  - P95 vs. Mean PSD frequency curve with annotated cutoff markers.
  - Sanitized RFC-4180 CSV batch report export.

## Security Architecture (`src/security/`)

Browser media decoders (`AudioContext.decodeAudioData`) wrap native codec libraries that are common targets for malformed-media vulnerabilities. TrueFLAC applies defense-in-depth before any file is decoded:

1. **Zero-Trust Magic-Byte & Container Validation:** Reads only a bounded 64 KB header slice first and strictly verifies binary signatures for FLAC (`fLaC` + 34-byte `STREAMINFO`), WAV (`RIFF`/`WAVE` + `fmt `/`data`), AIFF/AIFC (`FORM`), MP3 (`ID3` synchsafe or MPEG frame sync), M4A/MP4 audio (`ftyp` audio brand allowlist), and OGG (`OggS` + Vorbis/Opus/FLAC). Disguised executables, archives, and HTML/SVG/XML polyglots are rejected immediately.
2. **Bounds-Checked Parsing & DoS Protection:** All `DataView` reads are bounds-checked (`SafeReader`), container block/chunk loops are capped at 128 iterations, file size is capped at 350 MB (50 files per batch), uncompressed Float32 PCM memory is estimated pre-decode (450 MB ceiling), and decoding/DSP run under a 25-second per-file timeout with automatic Worker termination and recreation.
3. **Output & Export Hardening:** Filenames strip ASCII control and Unicode BiDi override characters (`U+202E` spoofing), CSV cells neutralize spreadsheet formula injection (`=`, `+`, `-`, `@`, `\t`, `\r`), and zero runtime network fetches or `dangerouslySetInnerHTML` sinks exist.

## Legacy Desktop Application

All original files from the legacy Python / PySide6 macOS desktop application have been preserved unchanged inside [`legacy-desktop/`](./legacy-desktop/).

## Local Development

```bash
npm install
npm run dev
```

The development server runs at `http://localhost:3000`.

## GitHub Pages Deployment

The repository includes `.github/workflows/deploy.yml` configured for Node 20 and `actions/deploy-pages@v4`, and `vite.config.ts` sets `base: process.env.GITHUB_ACTIONS ? '/flac_checker/' : './'` automatically during GitHub Actions builds.

1. Push to the `main` branch on GitHub.
2. In repository **Settings → Pages**, set **Source** to **GitHub Actions**.
3. The workflow builds `dist/` and publishes to `https://<username>.github.io/flac_checker/`.

*Note: Spectral forensics are heuristic—quiet, bandwidth-limited, or heavily mastered recordings should always be reviewed in the spectrogram and P95 frequency curve.*
