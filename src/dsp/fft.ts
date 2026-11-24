export function fft(real: Float64Array, imaginary: Float64Array): void {
  const size = real.length
  if (size !== imaginary.length || size < 2 || (size & (size - 1)) !== 0) {
    throw new RangeError('FFT requires equal-length, power-of-two arrays.')
  }
  let j = 0
  for (let i = 1; i < size; i += 1) {
    let bit = size >> 1
    while (j & bit) {
      j ^= bit
      bit >>= 1
    }
    j ^= bit
    if (i < j) {
      ;[real[i], real[j]] = [real[j], real[i]]
      ;[imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]]
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length
    const stepReal = Math.cos(angle)
    const stepImaginary = Math.sin(angle)
    for (let start = 0; start < size; start += length) {
      let twiddleReal = 1
      let twiddleImaginary = 0
      const half = length >> 1
      for (let offset = 0; offset < half; offset += 1) {
        const even = start + offset
        const odd = even + half
        const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary
        const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal
        real[odd] = real[even] - oddReal
        imaginary[odd] = imaginary[even] - oddImaginary
        real[even] += oddReal
        imaginary[even] += oddImaginary
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal
        twiddleReal = nextReal
      }
    }
  }
}

export function hann(size: number): Float64Array {
  const window = new Float64Array(size)
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, size - 1))
  }
  return window
}
