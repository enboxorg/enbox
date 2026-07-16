/**
 * Minimal QR code encoder — dependency-free, byte mode, ECC level M,
 * versions 1–10 with automatic version selection and standard mask
 * evaluation (ISO/IEC 18004 penalty rules N1–N4).
 *
 * Scope is deliberately narrow: it exists to render wallet-connect URIs in
 * the connect modal without adding a third-party runtime dependency. The
 * encoding pipeline follows the standard exactly — segment → codewords →
 * Reed-Solomon blocks → interleave → placement → mask — and the test suite
 * verifies full module-matrix equality against the `qrcode` npm package
 * (dev-only oracle) across versions and mask patterns.
 *
 * @module
 */

/** An encoded QR symbol: `modules[y][x]` is `true` for dark modules. */
export interface QrCode {
  /** Symbol width/height in modules (17 + 4×version). */
  size: number;

  /** Dark/light module matrix, row-major. */
  modules: boolean[][];

  /** Symbol version (1–10). */
  version: number;

  /** Applied mask pattern (0–7). */
  mask: number;
}

/** Error-correction level M codewords per block, indexed by version (1–10). */
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];

/** Error-correction level M block counts, indexed by version (1–10). */
const NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

/** Total codewords in the symbol, indexed by version (1–10). */
const TOTAL_CODEWORDS = [-1, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

/** Format-info error-correction bits for level M (`00` per the standard). */
const FORMAT_ECL_M = 0b00;

const MAX_VERSION = 10;

/** Data codeword capacity for level M at `version`. */
function dataCodewords(version: number): number {
  return TOTAL_CODEWORDS[version] - ECC_PER_BLOCK[version] * NUM_BLOCKS[version];
}

/**
 * Encodes UTF-8 text as a byte-mode QR symbol at ECC level M.
 *
 * @param text - The payload; encoded as UTF-8 bytes.
 * @param forcedMask - Optional mask override (0–7); defaults to the
 *                     penalty-minimising mask per the standard.
 * @returns The encoded symbol.
 * @throws If the payload does not fit in a version-10 level-M symbol.
 */
export function encodeQr(text: string, forcedMask?: number): QrCode {
  const data = new TextEncoder().encode(text);

  // ── Version selection: smallest version that fits the segment. ──
  let version = 0;
  for (let candidate = 1; candidate <= MAX_VERSION; candidate++) {
    const capacityBits = dataCodewords(candidate) * 8;
    const headerBits = 4 + (candidate <= 9 ? 8 : 16);
    if (headerBits + data.length * 8 <= capacityBits) {
      version = candidate;
      break;
    }
  }
  if (version === 0) {
    throw new Error(`[@enbox/browser] QR payload too long (${data.length} bytes exceeds version ${MAX_VERSION}-M capacity).`);
  }

  // ── Segment bits: mode 0100, char count, data, terminator, padding. ──
  const bits: number[] = [];
  const pushBits = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) {
      bits.push((value >>> i) & 1);
    }
  };

  pushBits(0b0100, 4);
  pushBits(data.length, version <= 9 ? 8 : 16);
  for (const byte of data) {
    pushBits(byte, 8);
  }

  const capacityBits = dataCodewords(version) * 8;
  pushBits(0, Math.min(4, capacityBits - bits.length)); // terminator
  pushBits(0, (8 - (bits.length % 8)) % 8); // byte align

  const padBytes = [0xEC, 0x11];
  let padIndex = 0;
  while (bits.length < capacityBits) {
    pushBits(padBytes[padIndex], 8);
    padIndex ^= 1; // alternate the two pad bytes
  }

  const codewords = new Uint8Array(capacityBits / 8);
  for (let i = 0; i < bits.length; i++) {
    codewords[i >> 3] |= bits[i] << (7 - (i & 7));
  }

  // ── Reed-Solomon blocks + interleave. ──
  const allCodewords = buildInterleavedCodewords(codewords, version);

  // ── Module placement. ──
  const size = 17 + 4 * version;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  drawFunctionPatterns(modules, isFunction, version);
  drawCodewords(modules, isFunction, allCodewords);

  // ── Mask selection: apply each mask, score, keep the best. ──
  let mask = forcedMask ?? -1;
  if (mask === -1) {
    let bestPenalty = Infinity;
    for (let candidate = 0; candidate < 8; candidate++) {
      applyMask(modules, isFunction, candidate);
      drawFormatBits(modules, isFunction, candidate);
      const penalty = computePenalty(modules);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        mask = candidate;
      }
      applyMask(modules, isFunction, candidate); // undo (XOR is involutive)
    }
  }

  applyMask(modules, isFunction, mask);
  drawFormatBits(modules, isFunction, mask);

  return { size, modules, version, mask };
}

/** Splits data codewords into level-M blocks, computes ECC, interleaves. */
function buildInterleavedCodewords(data: Uint8Array, version: number): Uint8Array {
  const numBlocks = NUM_BLOCKS[version];
  const eccLen = ECC_PER_BLOCK[version];
  const totalCodewords = TOTAL_CODEWORDS[version];

  const numShortBlocks = numBlocks - (totalCodewords % numBlocks);
  const shortBlockLen = Math.floor(totalCodewords / numBlocks);

  const blocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  const rsDivisor = reedSolomonDivisor(eccLen);

  let offset = 0;
  for (let i = 0; i < numBlocks; i++) {
    const dataLen = shortBlockLen - eccLen + (i < numShortBlocks ? 0 : 1);
    const block = data.slice(offset, offset + dataLen);
    offset += dataLen;
    blocks.push(block);
    eccBlocks.push(reedSolomonRemainder(block, rsDivisor));
  }

  const result = new Uint8Array(totalCodewords);
  let index = 0;
  const maxDataLen = shortBlockLen - eccLen + 1;
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < blocks[b].length) {
        result[index++] = blocks[b][i];
      }
    }
  }
  for (let i = 0; i < eccLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      result[index++] = eccBlocks[b][i];
    }
  }

  return result;
}

// ── GF(256) Reed-Solomon (polynomial 0x11D) ─────────────────────

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11D);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xFF;
}

/** Generator polynomial coefficients for `degree` ECC codewords. */
function reedSolomonDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;

  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) {
        result[j] ^= result[j + 1];
      }
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < divisor.length; i++) {
      result[i] ^= gfMultiply(divisor[i], factor);
    }
  }
  return result;
}

// ── Function patterns ───────────────────────────────────────────

/** Alignment pattern centre coordinates, indexed by version (1–10). */
const ALIGNMENT_POSITIONS: number[][] = [
  [], [],
  [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

function setFunctionModule(
  modules: boolean[][],
  isFunction: boolean[][],
  x: number,
  y: number,
  dark: boolean,
): void {
  modules[y][x] = dark;
  isFunction[y][x] = true;
}

function drawFunctionPatterns(modules: boolean[][], isFunction: boolean[][], version: number): void {
  const size = modules.length;

  // Timing patterns.
  for (let i = 0; i < size; i++) {
    setFunctionModule(modules, isFunction, 6, i, i % 2 === 0);
    setFunctionModule(modules, isFunction, i, 6, i % 2 === 0);
  }

  // Finder patterns (with separators) at three corners.
  drawFinderPattern(modules, isFunction, 3, 3);
  drawFinderPattern(modules, isFunction, size - 4, 3);
  drawFinderPattern(modules, isFunction, 3, size - 4);

  // Alignment patterns: all pairs except the three finder corners.
  const positions = ALIGNMENT_POSITIONS[version];
  for (let i = 0; i < positions.length; i++) {
    for (let j = 0; j < positions.length; j++) {
      const skip =
        (i === 0 && j === 0) ||
        (i === 0 && j === positions.length - 1) ||
        (i === positions.length - 1 && j === 0);
      if (!skip) {
        drawAlignmentPattern(modules, isFunction, positions[i], positions[j]);
      }
    }
  }

  // Format-info reserved areas (drawn with mask later, but the modules must
  // be marked as function modules before codeword placement).
  drawFormatBits(modules, isFunction, 0);

  // Dark module.
  setFunctionModule(modules, isFunction, 8, size - 8, true);

  // Version information (versions ≥ 7).
  if (version >= 7) {
    drawVersionBits(modules, isFunction, version);
  }
}

function drawFinderPattern(modules: boolean[][], isFunction: boolean[][], cx: number, cy: number): void {
  const size = modules.length;
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= size || y < 0 || y >= size) {
        continue;
      }
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      setFunctionModule(modules, isFunction, x, y, distance !== 2 && distance !== 4);
    }
  }
}

function drawAlignmentPattern(modules: boolean[][], isFunction: boolean[][], cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFunctionModule(modules, isFunction, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

/** 15-bit format info: 5 data bits BCH(15,5)-expanded, XORed with 0x5412. */
function drawFormatBits(modules: boolean[][], isFunction: boolean[][], mask: number): void {
  const size = modules.length;

  const data = (FORMAT_ECL_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  const bits = ((data << 10) | rem) ^ 0x5412;

  // Around the top-left finder.
  for (let i = 0; i <= 5; i++) {
    setFunctionModule(modules, isFunction, 8, i, ((bits >>> i) & 1) !== 0);
  }
  setFunctionModule(modules, isFunction, 8, 7, ((bits >>> 6) & 1) !== 0);
  setFunctionModule(modules, isFunction, 8, 8, ((bits >>> 7) & 1) !== 0);
  setFunctionModule(modules, isFunction, 7, 8, ((bits >>> 8) & 1) !== 0);
  for (let i = 9; i < 15; i++) {
    setFunctionModule(modules, isFunction, 14 - i, 8, ((bits >>> i) & 1) !== 0);
  }

  // Second copy: below the top-right finder and beside the bottom-left one.
  for (let i = 0; i < 8; i++) {
    setFunctionModule(modules, isFunction, size - 1 - i, 8, ((bits >>> i) & 1) !== 0);
  }
  for (let i = 8; i < 15; i++) {
    setFunctionModule(modules, isFunction, 8, size - 15 + i, ((bits >>> i) & 1) !== 0);
  }
}

/** 18-bit version info (versions ≥ 7): 6 data bits + BCH(18,6) remainder. */
function drawVersionBits(modules: boolean[][], isFunction: boolean[][], version: number): void {
  const size = modules.length;

  let rem = version;
  for (let i = 0; i < 12; i++) {
    rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
  }
  const bits = (version << 12) | rem;

  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) !== 0;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunctionModule(modules, isFunction, a, b, bit);
    setFunctionModule(modules, isFunction, b, a, bit);
  }
}

/** Zig-zag codeword placement over non-function modules. */
function drawCodewords(modules: boolean[][], isFunction: boolean[][], codewords: Uint8Array): void {
  const size = modules.length;
  let bitIndex = 0;

  for (let right = size - 1; right >= 1; right -= 2) {
    // Visit columns in right-to-left pairs, shifting one column left of the
    // vertical timing column (index 6) so it is skipped — without mutating the
    // loop counter (Sonar S2310). `size` is always odd, so `right` is always
    // even and `right - 1` maps 6→5, 4→3, 2→1, matching the original traversal.
    const rightCol = right <= 6 ? right - 1 : right;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = rightCol - j;
        const upward = ((rightCol + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (!isFunction[y][x] && bitIndex < codewords.length * 8) {
          modules[y][x] = ((codewords[bitIndex >> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
          bitIndex++;
        }
      }
    }
  }
}

/** XORs the mask pattern over non-function modules (involutive). */
function applyMask(modules: boolean[][], isFunction: boolean[][], mask: number): void {
  const size = modules.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isFunction[y][x]) {
        continue;
      }
      let invert: boolean;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (invert) {
        modules[y][x] = !modules[y][x];
      }
    }
  }
}

// ── Mask penalty scoring (rules N1–N4) ──────────────────────────

function computePenalty(modules: boolean[][]): number {
  const size = modules.length;
  let penalty = 0;

  // N1: runs of ≥5 same-colour modules in a row/column.
  for (let y = 0; y < size; y++) {
    let runColor = false;
    let runLength = 0;
    for (let x = 0; x < size; x++) {
      if (x === 0 || modules[y][x] !== runColor) {
        runColor = modules[y][x];
        runLength = 1;
      } else {
        runLength++;
        if (runLength === 5) {
          penalty += 3;
        } else if (runLength > 5) {
          penalty += 1;
        }
      }
    }
  }
  for (let x = 0; x < size; x++) {
    let runColor = false;
    let runLength = 0;
    for (let y = 0; y < size; y++) {
      if (y === 0 || modules[y][x] !== runColor) {
        runColor = modules[y][x];
        runLength = 1;
      } else {
        runLength++;
        if (runLength === 5) {
          penalty += 3;
        } else if (runLength > 5) {
          penalty += 1;
        }
      }
    }
  }

  // N2: 2×2 blocks of the same colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        penalty += 3;
      }
    }
  }

  // N3: finder-like 1:1:3:1:1 patterns with 4-module light flank.
  const hasFinderPattern = (line: boolean[], start: number): number => {
    const core = [true, false, true, true, true, false, true];
    const matchesCore = core.every((value, index) => line[start + index] === value);
    if (!matchesCore) {
      return 0;
    }
    const lightBefore = start >= 4 && line.slice(start - 4, start).every((v) => !v);
    const lightAfter = start + 11 <= line.length && line.slice(start + 7, start + 11).every((v) => !v);
    return (lightBefore ? 40 : 0) + (lightAfter ? 40 : 0);
  };

  for (let y = 0; y < size; y++) {
    const row = modules[y];
    const column = modules.map((r) => r[y]);
    for (let x = 0; x + 7 <= size; x++) {
      penalty += hasFinderPattern(row, x);
      penalty += hasFinderPattern(column, x);
    }
  }

  // N4: dark-module proportion deviation from 50%, in 5% steps.
  let dark = 0;
  for (const row of modules) {
    for (const module of row) {
      if (module) {
        dark++;
      }
    }
  }
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  penalty += k * 10;

  return penalty;
}

// ── SVG rendering ───────────────────────────────────────────────

/** Options for {@link qrToSvg}. */
export interface QrSvgOptions {
  /** Dark module colour. @default '#000000' */
  dark?: string;

  /** Light/background colour; `'transparent'` is allowed. @default '#ffffff' */
  light?: string;

  /** Quiet-zone width in modules on each side. @default 2 */
  quietZone?: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Renders an encoded symbol as a crisp, scalable `<svg>` element. One
 * `<path>` carries all dark modules so the output stays compact.
 *
 * Built with `createElementNS`/`setAttribute` rather than markup strings so
 * caller-supplied colours can never be interpreted as HTML (CodeQL
 * js/html-constructed-from-input). Append the returned element directly;
 * never serialize it back through `innerHTML`.
 */
export function qrToSvg(qr: QrCode, options: QrSvgOptions = {}): SVGSVGElement {
  const dark = options.dark ?? '#000000';
  const light = options.light ?? '#ffffff';
  const quietZone = options.quietZone ?? 2;
  const dimension = qr.size + quietZone * 2;

  let path = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) {
        path += `M${x + quietZone} ${y + quietZone}h1v1h-1z`;
      }
    }
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${dimension} ${dimension}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');

  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('width', String(dimension));
  rect.setAttribute('height', String(dimension));
  rect.setAttribute('fill', light);
  svg.appendChild(rect);

  const modules = document.createElementNS(SVG_NS, 'path');
  modules.setAttribute('d', path);
  modules.setAttribute('fill', dark);
  svg.appendChild(modules);

  return svg;
}
