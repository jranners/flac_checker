interface FftPlan {
  size: number;
  bitRev: Uint32Array;
  cosTable: Float64Array;
  sinTable: Float64Array;
  hann: Float64Array;
  hannSum: number;
}

const planCache = new Map<number, FftPlan>();

export function largestPow2Leq(n: number): number {
  if (n < 1) return 1;
  let p = 1;
  while ((p << 1) <= n) {
    p <<= 1;
  }
  return p;
}

export function getFftPlan(size: number): FftPlan {
  const cached = planCache.get(size);
  if (cached) return cached;

  const levels = Math.round(Math.log2(size));
  const bitRev = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let x = i;
    let r = 0;
    for (let j = 0; j < levels; j++) {
      r = (r << 1) | (x & 1);
      x >>>= 1;
    }
    bitRev[i] = r;
  }

  const half = size >>> 1;
  const cosTable = new Float64Array(half);
  const sinTable = new Float64Array(half);
  const angleStep = (-2 * Math.PI) / size;
  for (let i = 0; i < half; i++) {
    const angle = angleStep * i;
    cosTable[i] = Math.cos(angle);
    sinTable[i] = Math.sin(angle);
  }

  const hann = new Float64Array(size);
  let hannSum = 0;
  const winFactor = (2 * Math.PI) / size;
  for (let i = 0; i < size; i++) {
    const w = 0.5 - 0.5 * Math.cos(winFactor * i);
    hann[i] = w;
    hannSum += w;
  }

  const plan: FftPlan = { size, bitRev, cosTable, sinTable, hann, hannSum };
  planCache.set(size, plan);
  return plan;
}

/**
 * Iterative in-place Radix-2 Cooley-Tukey FFT.
 * `re` and `im` must have power-of-2 length.
 */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n <= 1) return;

  const { bitRev, cosTable, sinTable } = getFftPlan(n);

  for (let i = 0; i < n; i++) {
    const j = bitRev[i];
    if (j > i) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;

      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let size = 2; size <= n; size <<= 1) {
    const halfSize = size >>> 1;
    const tableStep = n / size;
    for (let i = 0; i < n; i += size) {
      let k = 0;
      for (let j = i; j < i + halfSize; j++) {
        const l = j + halfSize;
        const c = cosTable[k];
        const s = sinTable[k];
        const tRe = re[l] * c - im[l] * s;
        const tIm = re[l] * s + im[l] * c;
        re[l] = re[j] - tRe;
        im[l] = im[j] - tIm;
        re[j] += tRe;
        im[j] += tIm;
        k += tableStep;
      }
    }
  }
}
