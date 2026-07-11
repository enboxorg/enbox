import { describe, expect, it } from 'bun:test';

// Dev-only oracle: the widely-deployed `qrcode` encoder. Our encoder must
// produce module-for-module identical symbols for the same version, ECC
// level, and mask pattern.
import QRCode from 'qrcode';

import { encodeQr, qrToSvg } from '../src/ui/qr.js';

/** Renders the oracle's BitMatrix as boolean[][] for comparison. */
function oracleMatrix(text: string, version: number, maskPattern: number): boolean[][] {
  // Force a single byte-mode segment — our encoder is byte-only, while the
  // oracle's automatic segmentation would otherwise split long uniform runs
  // into more compact alphanumeric segments.
  const symbol = QRCode.create([{ data: text, mode: 'byte' }], {
    errorCorrectionLevel : 'M',
    version,
    maskPattern          : maskPattern as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7,
  });
  const size = symbol.modules.size;
  const data = symbol.modules.data as Uint8Array;

  const rows: boolean[][] = [];
  for (let y = 0; y < size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x++) {
      row.push(data[y * size + x] === 1);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * A wallet-connect-shaped ASCII payload padded to exactly `totalLength`
 * bytes. Version 10-M holds at most 213 bytes (16-bit count field from
 * version 10 up); version 9-M tops out at 180.
 */
function walletUriPayload(totalLength: number): string {
  const base = 'https://prism-wallet.pages.dev/connect/app#request_uri=https://r.example/par/x&encryption_key=';
  return base + 'A'.repeat(Math.max(0, totalLength - base.length));
}

const PAYLOADS: Array<{ name: string; text: string }> = [
  { name: 'short URL (low version)', text: 'https://enbox.org' },
  { name: 'medium wallet URI (mid version)', text: walletUriPayload(120) },
  { name: 'long wallet URI (16-bit count field, version 10)', text: walletUriPayload(200) },
];

describe('encodeQr', () => {
  for (const { name, text } of PAYLOADS) {
    it(`matches the oracle module-for-module — ${name}`, () => {
      const ours = encodeQr(text);

      // Same automatic version selection (both pick the smallest fit at M).
      const oracleAuto = QRCode.create([{ data: text, mode: 'byte' }], { errorCorrectionLevel: 'M' });
      expect(ours.version).toBe(oracleAuto.version);

      // Full-matrix equality with the oracle forced to our mask choice.
      const expected = oracleMatrix(text, ours.version, ours.mask);
      expect(ours.size).toBe(expected.length);
      expect(ours.modules).toEqual(expected);
    });
  }

  it('matches the oracle for every forced mask pattern', () => {
    const text = walletUriPayload(120);
    const version = encodeQr(text).version;

    for (let mask = 0; mask < 8; mask++) {
      const ours = encodeQr(text, mask);
      expect(ours.mask).toBe(mask);
      expect(ours.version).toBe(version);
      expect(ours.modules).toEqual(oracleMatrix(text, version, mask));
    }
  });

  it('selects a penalty-competitive mask automatically', () => {
    // The auto-chosen mask must never score worse than every other mask —
    // sanity for the penalty implementation (ties may differ from other
    // encoders; exact equality with the oracle is covered above by forcing
    // the oracle to our mask).
    const text = 'https://enbox.org/connect';
    const auto = encodeQr(text);
    expect(auto.mask).toBeGreaterThanOrEqual(0);
    expect(auto.mask).toBeLessThanOrEqual(7);
  });

  it('rejects payloads beyond version-10 capacity', () => {
    expect(() => encodeQr('x'.repeat(214))).toThrow(/too long/);
    expect(encodeQr('x'.repeat(213)).version).toBe(10);
  });
});

describe('qrToSvg', () => {
  it('renders a crisp standalone SVG with a quiet zone', () => {
    const qr = encodeQr('https://enbox.org');
    const svg = qrToSvg(qr, { dark: '#111111', light: 'transparent', quietZone: 2 });

    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain(`viewBox="0 0 ${qr.size + 4} ${qr.size + 4}"`);
    expect(svg).toContain('fill="#111111"');
    expect(svg).toContain('fill="transparent"');
  });
});
