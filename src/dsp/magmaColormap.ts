/**
 * Deep-black perceptual Magma / Inferno colormap (256 RGB entries).
 * Anchored in true obsidian black at low dBFS for crisp Retina spectrogram contrast.
 */
const MAGMA_INFERNO_STOPS: ReadonlyArray<[number, number, number]> = [
  [2, 2, 5],
  [10, 7, 26],
  [27, 12, 58],
  [54, 15, 92],
  [84, 18, 114],
  [114, 27, 122],
  [145, 38, 120],
  [175, 50, 112],
  [202, 66, 98],
  [224, 88, 79],
  [241, 117, 58],
  [250, 150, 44],
  [253, 184, 52],
  [252, 217, 94],
  [252, 246, 168],
];

function buildColormapLut(): Uint8Array {
  const lut = new Uint8Array(256 * 3);
  const maxStop = MAGMA_INFERNO_STOPS.length - 1;
  for (let i = 0; i < 256; i++) {
    const pos = (i / 255) * maxStop;
    const idx = Math.min(maxStop - 1, Math.floor(pos));
    const frac = pos - idx;
    const c0 = MAGMA_INFERNO_STOPS[idx];
    const c1 = MAGMA_INFERNO_STOPS[idx + 1];
    lut[i * 3] = Math.round(c0[0] + (c1[0] - c0[0]) * frac);
    lut[i * 3 + 1] = Math.round(c0[1] + (c1[1] - c0[1]) * frac);
    lut[i * 3 + 2] = Math.round(c0[2] + (c1[2] - c0[2]) * frac);
  }
  return lut;
}

export const SPECTROGRAM_LUT = buildColormapLut();
