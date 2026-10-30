/**
 * QR Code encoder for the Bilibili sign-in URL.
 *
 * The host encodes the passport URL itself because the browser half cannot
 * encode and the plugin carries no dependency. This module implements
 * ISO/IEC 18004 byte mode at error-correction level M for versions 1 to 10,
 * choosing the smallest version that fits the UTF-8 payload and the mask with
 * the lowest penalty score. It owns the Reed-Solomon arithmetic over GF(256)
 * and the version tables it needs; nothing else in the plugin encodes symbols.
 *
 * @module dsh-bilibili/src/qr
 */

import { Buffer } from 'node:buffer'

/** Highest symbol version this encoder produces. */
const MAX_VERSION = 10

/** Byte-mode payload that still fits version 10 at error-correction level M. */
const MAX_BYTES = 213

/**
 * Level-M block layout per version, from ISO/IEC 18004 table 9.
 *
 * Each row is `[ecCodewordsPerBlock, group1Blocks, group1Data, group2Blocks,
 * group2Data]`, where a group's data entry is its codeword count per block.
 */
const BLOCKS_M = Object.freeze([
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
])

/** Total codewords, data plus error correction, per version. */
const TOTAL_CODEWORDS = Object.freeze([26, 44, 70, 100, 134, 172, 196, 242, 292, 346])

/** Alignment-pattern centre coordinates per version; version 1 has none. */
const ALIGNMENT_CENTERS = Object.freeze([
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
])

/** Remainder bits left light after the last codeword, per version. */
const REMAINDER_BITS = Object.freeze([0, 7, 7, 7, 7, 7, 0, 0, 0, 0])

/** Error-correction level M indicator bits in the format information. */
const ECC_LEVEL_M_BITS = 0b00

/** Generator polynomial of the BCH(15, 5) format-information code. */
const FORMAT_GENERATOR = 0b10100110111

/** Mask XORed onto every format value, per the standard. */
const FORMAT_MASK = 0b101010000010010

/** Generator polynomial of the BCH(18, 6) version-information code. */
const VERSION_GENERATOR = 0b1111100100101

/** Both 11-module finder-like sequences penalised by penalty rule 3. */
const FINDER_LIKE = Object.freeze([0b10111010000, 0b00001011101])

/** Primitive polynomial of the GF(256) field QR Codes use. */
const GF_PRIMITIVE = 0x11d

/** Antilog table; `GF_EXP[exponent]` is the field element. */
const GF_EXP = new Uint8Array(512)

/** Logarithm table; `GF_LOG[element]` is its exponent, with `GF_LOG[0]` unused. */
const GF_LOG = new Uint8Array(256)

for (let exponent = 0, element = 1; exponent < 255; exponent++) {
  GF_EXP[exponent] = element
  GF_LOG[element] = exponent
  element <<= 1
  if (element & 0x100) element ^= GF_PRIMITIVE
}
for (let exponent = 255; exponent < 512; exponent++) GF_EXP[exponent] = GF_EXP[exponent - 255]

/**
 * Matrix positions of the first 15-bit format-information copy, by bit index.
 *
 * Bit `i` is the coefficient of `2 ** i`; positions are `[row, column]` pairs.
 * The timing row and column cells are absent because they belong to the timing
 * patterns.
 */
const FORMAT_POSITIONS_PRIMARY = Object.freeze([
  [0, 8],
  [1, 8],
  [2, 8],
  [3, 8],
  [4, 8],
  [5, 8],
  [7, 8],
  [8, 8],
  [8, 7],
  [8, 5],
  [8, 4],
  [8, 3],
  [8, 2],
  [8, 1],
  [8, 0],
])

/**
 * Multiply two GF(256) elements.
 * @param a - First field element.
 * @param b - Second field element.
 * @returns the product, or 0 when either factor is 0.
 */
function gfMultiply(a, b) {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

/**
 * Build the Reed-Solomon generator polynomial for a degree.
 * @param degree - Error-correction codewords per block.
 * @returns coefficients from the leading term down to the constant term.
 */
function generatorPolynomial(degree) {
  let polynomial = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(polynomial.length + 1).fill(0)
    for (let j = 0; j < polynomial.length; j++) {
      next[j] ^= polynomial[j]
      next[j + 1] ^= gfMultiply(polynomial[j], GF_EXP[i])
    }
    polynomial = next
  }
  return polynomial
}

/**
 * Compute one block's error-correction codewords by polynomial division.
 * @param data - The block's data codewords.
 * @param ecCount - Error-correction codewords to produce.
 * @returns the block's error-correction codewords.
 */
function reedSolomon(data, ecCount) {
  const generator = generatorPolynomial(ecCount)
  const remainder = new Uint8Array(ecCount)
  for (const codeword of data) {
    const factor = codeword ^ remainder[0]
    remainder.copyWithin(0, 1)
    remainder[ecCount - 1] = 0
    for (let i = 0; i < ecCount; i++) remainder[i] ^= gfMultiply(generator[i + 1], factor)
  }
  return remainder
}

/**
 * Width of the byte-mode character-count indicator.
 * @param version - Symbol version.
 * @returns 8 bits for versions 1 to 9, 16 bits from version 10.
 */
function countBits(version) {
  return version < 10 ? 8 : 16
}

/**
 * Data codeword count of a version at level M.
 * @param version - Symbol version.
 * @returns the codewords available to data before error correction.
 */
function dataCodewordCount(version) {
  const [, group1Blocks, group1Data, group2Blocks, group2Data] = BLOCKS_M[version - 1]
  return group1Blocks * group1Data + group2Blocks * group2Data
}

/**
 * Append the low `width` bits of a value to a bit stream, most significant first.
 * @param bits - Destination bit array.
 * @param value - Value to append.
 * @param width - Bit width to append.
 */
function pushBits(bits, value, width) {
  for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1)
}

/**
 * Choose the smallest version whose level-M capacity fits a byte-mode payload.
 * @param byteLength - Payload length in UTF-8 bytes.
 * @returns the symbol version, 1 to `MAX_VERSION`.
 * @throws when the payload exceeds version 10 at level M.
 */
function selectVersion(byteLength) {
  for (let version = 1; version <= MAX_VERSION; version++) {
    const usableBits = dataCodewordCount(version) * 8 - 4 - countBits(version)
    if (byteLength * 8 <= usableBits) return version
  }
  throw new Error(
    `QR payload is ${byteLength} bytes, above the ${MAX_BYTES}-byte limit of version ${MAX_VERSION} at error-correction level M`,
  )
}

/**
 * Encode bytes as the final interleaved data and error-correction codewords.
 * @param bytes - Payload bytes.
 * @param version - Symbol version.
 * @returns the codeword stream in placement order.
 */
function buildCodewords(bytes, version) {
  const [ecPerBlock, group1Blocks, group1Data, group2Blocks, group2Data] = BLOCKS_M[version - 1]
  const dataCount = group1Blocks * group1Data + group2Blocks * group2Data
  const capacityBits = dataCount * 8

  const bits = []
  pushBits(bits, 0b0100, 4)
  pushBits(bits, bytes.length, countBits(version))
  for (const byte of bytes) pushBits(bits, byte, 8)
  pushBits(bits, 0, Math.min(4, capacityBits - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)
  for (let i = 0; bits.length < capacityBits; i++) pushBits(bits, i % 2 === 0 ? 0xec : 0x11, 8)

  const data = new Uint8Array(dataCount)
  for (let i = 0; i < bits.length; i++) data[i >> 3] |= bits[i] << (7 - (i & 7))

  const blocks = []
  let offset = 0
  for (let i = 0; i < group1Blocks; i++) {
    blocks.push(data.subarray(offset, offset + group1Data))
    offset += group1Data
  }
  for (let i = 0; i < group2Blocks; i++) {
    blocks.push(data.subarray(offset, offset + group2Data))
    offset += group2Data
  }
  const ecBlocks = blocks.map((block) => reedSolomon(block, ecPerBlock))

  const stream = []
  const longest = Math.max(group1Data, group2Data)
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) if (i < block.length) stream.push(block[i])
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) stream.push(block[i])
  }
  return Uint8Array.from(stream)
}

/**
 * Encode a symbol version as its 18-bit BCH-protected version value.
 * @param version - Symbol version, 7 or higher.
 * @returns the 18-bit version information.
 */
function versionInformation(version) {
  let remainder = version
  for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * VERSION_GENERATOR)
  return (version << 12) | remainder
}

/**
 * Encode format bits as the 15-bit BCH-protected format value.
 * @param eccBits - Error-correction level indicator bits.
 * @param mask - Mask pattern index.
 * @returns the masked 15-bit format information.
 */
function formatBits(eccBits, mask) {
  const data = (eccBits << 3) | mask
  let remainder = data
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * FORMAT_GENERATOR)
  return ((data << 10) | remainder) ^ FORMAT_MASK
}

/**
 * Position of bit `i` in the second format-information copy.
 * @param i - Format bit index, 0 to 14.
 * @param size - Symbol side length in modules.
 * @returns the `[row, column]` position.
 */
function formatPositionSecondary(i, size) {
  return i < 8 ? [8, size - 1 - i] : [size - 15 + i, 8]
}

/**
 * Test whether a mask pattern inverts a module.
 * @param mask - Mask pattern index, 0 to 7.
 * @param row - Module row.
 * @param col - Module column.
 * @returns `true` when the mask inverts that position.
 */
function maskApplies(mask, row, col) {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0
    case 1:
      return row % 2 === 0
    case 2:
      return col % 3 === 0
    case 3:
      return (row + col) % 3 === 0
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
    case 7:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
    default:
      throw new Error(`QR mask pattern ${mask} is outside the supported range 0 to 7`)
  }
}

/**
 * Draw every function pattern and place the data bits, leaving the symbol
 * unmasked.
 * @param version - Symbol version.
 * @param codewords - Interleaved codeword stream.
 * @returns the module matrix and a map of the modules data must not occupy.
 * @throws when the level-M tables disagree with the drawn function patterns.
 */
function buildSymbol(version, codewords) {
  const size = version * 4 + 17
  const modules = Array.from({ length: size }, () => new Array(size).fill(false))
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false))
  const set = (row, col, dark) => {
    if (row < 0 || row >= size || col < 0 || col >= size) return
    modules[row][col] = dark
    reserved[row][col] = true
  }

  for (const [row, col] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6
        set(row + r, col + c, inside && Math.max(Math.abs(r - 3), Math.abs(c - 3)) !== 2)
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }

  const centers = ALIGNMENT_CENTERS[version - 1]
  const far = size - 7
  for (const row of centers) {
    for (const col of centers) {
      if ((row === 6 && col === 6) || (row === 6 && col === far) || (row === far && col === 6)) continue
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) set(row + r, col + c, Math.max(Math.abs(r), Math.abs(c)) !== 1)
      }
    }
  }

  if (version >= 7) {
    const bits = versionInformation(version)
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >> i) & 1) === 1
      const offset = size - 11 + (i % 3)
      const index = Math.floor(i / 3)
      set(index, offset, dark)
      set(offset, index, dark)
    }
  }

  set(size - 8, 8, true)
  for (let i = 0; i < 9; i++) {
    if (i === 6) continue
    set(8, i, false)
    set(i, 8, false)
  }
  for (let i = 0; i < 8; i++) set(8, size - 1 - i, false)
  for (let i = 8; i < 15; i++) set(size - 15 + i, 8, false)

  const totalBits = codewords.length * 8
  let placed = 0
  // Two-module-wide columns from the right, alternating upward and downward.
  // Column 6 is the vertical timing pattern, so the walk that would start there
  // shifts one column left and continues at 5, 3, 1.
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    const upward = ((right + 1) & 2) === 0
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step
      for (let offset = 0; offset < 2; offset++) {
        const col = right - offset
        if (reserved[row][col]) continue
        const dark = placed < totalBits ? ((codewords[placed >> 3] >> (7 - (placed & 7))) & 1) === 1 : false
        modules[row][col] = dark
        placed++
      }
    }
  }

  const expected = TOTAL_CODEWORDS[version - 1] * 8 + REMAINDER_BITS[version - 1]
  if (placed !== expected) {
    throw new Error(
      `QR version ${version} tables disagree with its function patterns: ${placed} data modules drawn, ${expected} expected`,
    )
  }
  return { modules, reserved }
}

/**
 * Write both copies of the format information into a matrix.
 * @param modules - Module matrix to modify.
 * @param size - Symbol side length in modules.
 * @param mask - Mask pattern index.
 */
function writeFormat(modules, size, mask) {
  const bits = formatBits(ECC_LEVEL_M_BITS, mask)
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >> i) & 1) === 1
    const [row, col] = FORMAT_POSITIONS_PRIMARY[i]
    modules[row][col] = dark
    const [otherRow, otherCol] = formatPositionSecondary(i, size)
    modules[otherRow][otherCol] = dark
  }
}

/**
 * Penalty rule 1: runs of five or more same-coloured modules.
 * @param modules - Module matrix.
 * @returns the accumulated penalty.
 */
function penaltyRuns(modules) {
  const size = modules.length
  let penalty = 0
  for (let i = 0; i < size; i++) {
    let rowRun = 1
    let colRun = 1
    for (let j = 1; j < size; j++) {
      rowRun = modules[i][j] === modules[i][j - 1] ? rowRun + 1 : 1
      if (rowRun === 5) penalty += 3
      else if (rowRun > 5) penalty += 1
      colRun = modules[j][i] === modules[j - 1][i] ? colRun + 1 : 1
      if (colRun === 5) penalty += 3
      else if (colRun > 5) penalty += 1
    }
  }
  return penalty
}

/**
 * Penalty rule 2: every two-by-two block of one colour.
 * @param modules - Module matrix.
 * @returns the accumulated penalty.
 */
function penaltyBlocks(modules) {
  const size = modules.length
  let penalty = 0
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const color = modules[row][col]
      if (color === modules[row][col + 1] && color === modules[row + 1][col] && color === modules[row + 1][col + 1]) {
        penalty += 3
      }
    }
  }
  return penalty
}

/**
 * Penalty rule 3: finder-like sequences in a row or column.
 * @param modules - Module matrix.
 * @returns the accumulated penalty.
 */
function penaltyFinderLike(modules) {
  const size = modules.length
  let penalty = 0
  for (let i = 0; i < size; i++) {
    let rowBits = 0
    let colBits = 0
    for (let j = 0; j < size; j++) {
      rowBits = ((rowBits << 1) & 0x7ff) | (modules[i][j] ? 1 : 0)
      colBits = ((colBits << 1) & 0x7ff) | (modules[j][i] ? 1 : 0)
      if (j >= 10 && FINDER_LIKE.includes(rowBits)) penalty += 40
      if (j >= 10 && FINDER_LIKE.includes(colBits)) penalty += 40
    }
  }
  return penalty
}

/**
 * Penalty rule 4: deviation of the dark-module share from one half.
 * @param modules - Module matrix.
 * @returns the accumulated penalty.
 */
function penaltyBalance(modules) {
  let dark = 0
  for (const row of modules) {
    for (const module of row) if (module) dark++
  }
  const percent = (dark * 100) / (modules.length * modules.length)
  return Math.floor(Math.abs(percent - 50) / 5) * 10
}

/**
 * Score a masked symbol with the standard's four penalty rules.
 * @param modules - Module matrix including format information.
 * @returns the total penalty, where lower is better.
 */
function penaltyScore(modules) {
  return penaltyRuns(modules) + penaltyBlocks(modules) + penaltyFinderLike(modules) + penaltyBalance(modules)
}

/**
 * Apply every mask, score the result, and keep the lowest-penalty symbol.
 * @param modules - Unmasked module matrix with data placed.
 * @param reserved - Map of the modules belonging to function patterns.
 * @param size - Symbol side length in modules.
 * @returns the final masked matrix.
 */
function selectMask(modules, reserved, size) {
  let best = null
  let bestPenalty = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const candidate = modules.map((row) => row.slice())
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (!reserved[row][col] && maskApplies(mask, row, col)) candidate[row][col] = !candidate[row][col]
      }
    }
    writeFormat(candidate, size, mask)
    const penalty = penaltyScore(candidate)
    if (penalty < bestPenalty) {
      bestPenalty = penalty
      best = candidate
    }
  }
  return best
}

/**
 * Encode text as a QR Code symbol matrix.
 *
 * The payload is UTF-8 encoded, so a URL of ASCII characters occupies one byte
 * per character. The matrix carries no quiet zone; callers that render it add
 * the four-module margin themselves.
 *
 * @param text - Payload to encode.
 * @returns the symbol matrix, where `matrix[row][column]` is `true` for a dark
 *   module and the side length is `4 * version + 17`.
 * @throws when the UTF-8 payload exceeds the 213-byte limit of version 10 at
 *   error-correction level M.
 */
export function qrMatrix(text) {
  const bytes = Buffer.from(text, 'utf8')
  const version = selectVersion(bytes.length)
  const codewords = buildCodewords(bytes, version)
  const { modules, reserved } = buildSymbol(version, codewords)
  return selectMask(modules, reserved, modules.length)
}

/**
 * Render text as a standalone SVG image of its QR Code symbol.
 *
 * Every dark module becomes one rectangle subpath of a single `<path>`, so a
 * large symbol stays one DOM node. Rectangle edges sit on whole pixels for the
 * default integer scale, which `shape-rendering="crispEdges"` keeps sharp.
 *
 * @param text - Payload to encode.
 * @param options - Rendering options.
 * @param options.scale - Pixels per module; defaults to 8.
 * @param options.margin - Quiet-zone width in modules; defaults to 4.
 * @returns an SVG document covering the symbol and its quiet zone.
 * @throws when the payload is too long, or when scale or margin is not an
 *   integer within its range.
 */
export function qrSvg(text, options = {}) {
  const scale = options.scale ?? 8
  const margin = options.margin ?? 4
  if (!Number.isInteger(scale) || scale <= 0) {
    throw new Error(`qrSvg scale must be a positive integer, received ${String(scale)}`)
  }
  if (!Number.isInteger(margin) || margin < 0) {
    throw new Error(`qrSvg margin must be a non-negative integer, received ${String(margin)}`)
  }

  const matrix = qrMatrix(text)
  const size = matrix.length
  const extent = (size + margin * 2) * scale
  let path = ''
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!matrix[row][col]) continue
      path += `M${(col + margin) * scale} ${(row + margin) * scale}h${scale}v${scale}h-${scale}z`
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${extent}" height="${extent}"`
    + ` viewBox="0 0 ${extent} ${extent}" shape-rendering="crispEdges">`
    + `<rect width="${extent}" height="${extent}" fill="#ffffff"/>`
    + `<path fill="#000000" d="${path}"/>`
    + '</svg>'
}

/**
 * Render text as a base64 SVG data URL of its QR Code symbol.
 * @param text - Payload to encode.
 * @param options - Rendering options, as accepted by {@link qrSvg}.
 * @returns a `data:image/svg+xml;base64,` URL an `<img>` element can display.
 * @throws when the payload is too long, or when scale or margin is not an
 *   integer within its range.
 */
export function qrSvgDataUrl(text, options = {}) {
  const svg = qrSvg(text, options)
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}
