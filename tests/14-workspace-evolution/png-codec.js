/**
 * Minimal PNG encoder/decoder for the local WMS stand-in.
 *
 * Only the bounded subset this experiment actually produces is supported:
 * 8-bit truecolour (colour type 2), no interlace, filter type 0 on every row.
 * That is deliberately narrower than PNG itself; callers must not present it
 * as a general-purpose codec. Both directions check structure and CRCs so the
 * evidence is derived from real image bytes, not from a fixed fixture.
 */
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function assertDimension(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 4096) {
    throw Object.assign(new Error(`${label} must be an integer between 1 and 4096`), {
      code: 'png-invalid-dimension',
    });
  }
}

/**
 * @param {{width: number, height: number, rgb: Buffer|Uint8Array}} input
 * @returns {Buffer}
 */
export function encodePng({ width, height, rgb } = {}) {
  assertDimension(width, 'width');
  assertDimension(height, 'height');
  const expectedLength = width * height * 3;
  if (!rgb || rgb.length !== expectedLength) {
    throw Object.assign(new Error('rgb must contain exactly width * height * 3 bytes'), {
      code: 'png-invalid-raster',
    });
  }
  const rowLength = width * 3;
  const raw = Buffer.alloc(height * (rowLength + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (rowLength + 1);
    raw[rowStart] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * rowLength, rowLength).copy(raw, rowStart + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * @param {Buffer|Uint8Array} input
 * @returns {{width: number, height: number, rgb: Buffer}}
 */
export function decodePng(input) {
  if (!Buffer.isBuffer(input)) {
    if (!(input instanceof Uint8Array)) {
      throw Object.assign(new Error('PNG input must be bytes'), { code: 'png-invalid-input' });
    }
    input = Buffer.from(input);
  }
  if (input.length < SIGNATURE.length || input.length > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error('PNG byte length is outside the supported range'), {
      code: 'png-invalid-input',
    });
  }
  if (!input.subarray(0, 8).equals(SIGNATURE)) {
    throw Object.assign(new Error('PNG signature is missing'), { code: 'png-invalid-signature' });
  }

  let offset = 8;
  let header = null;
  const idat = [];
  let sawEnd = false;

  while (offset < input.length) {
    if (offset + 8 > input.length) {
      throw Object.assign(new Error('truncated PNG chunk header'), { code: 'png-truncated' });
    }
    const length = input.readUInt32BE(offset);
    const type = input.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    if (length > MAX_IMAGE_BYTES || crcEnd > input.length) {
      throw Object.assign(new Error(`PNG chunk ${type} exceeds the remaining bytes`), {
        code: 'png-truncated',
      });
    }
    const data = input.subarray(dataStart, dataEnd);
    const expectedCrc = input.readUInt32BE(dataEnd);
    const observedCrc = crc32(input.subarray(offset + 4, dataEnd));
    if (expectedCrc !== observedCrc) {
      throw Object.assign(new Error(`PNG chunk ${type} failed its CRC check`), {
        code: 'png-crc-mismatch',
      });
    }

    if (type === 'IHDR') {
      if (length !== 13 || header) {
        throw Object.assign(new Error('PNG has an invalid or repeated IHDR'), {
          code: 'png-invalid-header',
        });
      }
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colourType = data[9];
      const compression = data[10];
      const filter = data[11];
      const interlace = data[12];
      if (width < 1 || height < 1 || width * height * 3 > MAX_IMAGE_BYTES) {
        throw Object.assign(new Error('PNG dimensions are outside the supported range'), {
          code: 'png-invalid-header',
        });
      }
      if (bitDepth !== 8 || colourType !== 2) {
        throw Object.assign(new Error('only 8-bit truecolour PNG is supported'), {
          code: 'png-unsupported-format',
        });
      }
      if (compression !== 0 || filter !== 0 || interlace !== 0) {
        throw Object.assign(new Error('PNG compression, filter, or interlace method is unsupported'), {
          code: 'png-unsupported-format',
        });
      }
      header = { width, height };
    } else if (type === 'IDAT') {
      if (!header) {
        throw Object.assign(new Error('PNG IDAT appeared before IHDR'), {
          code: 'png-invalid-chunk-order',
        });
      }
      idat.push(data);
    } else if (type === 'IEND') {
      sawEnd = true;
      break;
    }

    offset = crcEnd;
  }

  if (!header || !sawEnd || idat.length === 0) {
    throw Object.assign(new Error('PNG is missing IHDR, IDAT, or IEND'), {
      code: 'png-truncated',
    });
  }

  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: MAX_IMAGE_BYTES });
  } catch (error) {
    throw Object.assign(new Error(`PNG image data could not be inflated: ${error.message}`), {
      code: 'png-invalid-data',
      cause: error,
    });
  }

  const rowLength = header.width * 3;
  const expectedRawLength = header.height * (rowLength + 1);
  if (raw.length !== expectedRawLength) {
    throw Object.assign(new Error('PNG image data length does not match its dimensions'), {
      code: 'png-invalid-data',
    });
  }

  const rgb = Buffer.alloc(header.width * header.height * 3);
  for (let y = 0; y < header.height; y += 1) {
    const rowStart = y * (rowLength + 1);
    if (raw[rowStart] !== 0) {
      throw Object.assign(new Error(`PNG row ${y} uses unsupported filter ${raw[rowStart]}`), {
        code: 'png-unsupported-filter',
      });
    }
    raw.copy(rgb, y * rowLength, rowStart + 1, rowStart + 1 + rowLength);
  }

  return { width: header.width, height: header.height, rgb };
}

/**
 * Read one RGB pixel. Bounds are validated instead of clamped.
 */
export function pixelAt(image, x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y) ||
      x < 0 || y < 0 || x >= image.width || y >= image.height) {
    throw new RangeError('pixel coordinates are outside the decoded image');
  }
  const offset = (y * image.width + x) * 3;
  return [image.rgb[offset], image.rgb[offset + 1], image.rgb[offset + 2]];
}
