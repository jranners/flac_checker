# TrueFLAC

TrueFLAC is a fully client-side audio inspection app. It reads FLAC/WAV metadata
from the file headers, decodes audio in the browser, and uses a TypeScript FFT
to look for spectral cutoffs that can indicate a lossy transcode. Files are
never uploaded.

## Local development

Requires Node.js 20 or newer.

```bash
npm install
npm run dev
```

Create a production build with `npm run build`; preview it locally with
`npm run preview`.

## GitHub Pages deployment

The GitHub Actions workflow at `.github/workflows/deploy.yml` builds and deploys
on each push to `main` (and can also be started manually). In the repository's
**Settings → Pages**, set the build and deployment source to **GitHub Actions**.
Vite is configured with the project Pages URL base `/flac_checker/`.

## Analysis notes

FLAC STREAMINFO and WAV RIFF/fmt metadata are read directly from binary headers;
other supported formats use browser decoding for metadata. Three representative
audio segments are analyzed in a Web Worker. Cutoff patterns around 16 kHz,
18.5 kHz, and 20.2 kHz are heuristic indicators, not proof of a file's history:
recording, mastering, and source material also shape the spectrum. Browser codec
support determines which audio formats can be decoded.

## Previous desktop application

The original Python/PySide6 application and its tests are preserved in
[`legacy-desktop/`](legacy-desktop/).
