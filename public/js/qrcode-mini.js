// Minimal QR Code generator - supports alphanumeric URLs
// Based on QR Code specification with Mode 4 (byte), ECC Level L

const QRMini = (() => {
  // Pre-computed GF(256) tables
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x = (x << 1) ^ (x & 128 ? 0x11d : 0);
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gfMul(a, b) {
    return a && b ? EXP[LOG[a] + LOG[b]] : 0;
  }

  function polyMul(a, b) {
    const r = new Uint8Array(a.length + b.length - 1);
    for (let i = 0; i < a.length; i++)
      for (let j = 0; j < b.length; j++)
        r[i + j] ^= gfMul(a[i], b[j]);
    return r;
  }

  function polyRemainder(data, gen) {
    const r = new Uint8Array(data.length + gen.length - 1);
    r.set(data);
    for (let i = 0; i < data.length; i++) {
      if (r[i]) {
        for (let j = 0; j < gen.length; j++)
          r[i + j] ^= gfMul(gen[j], r[i]);
      }
    }
    return r.slice(data.length);
  }

  function genPoly(n) {
    let g = new Uint8Array([1]);
    for (let i = 0; i < n; i++)
      g = polyMul(g, new Uint8Array([1, EXP[i]]));
    return g;
  }

  // QR version configs: [version, totalCodewords, eccCodewords, numBlocks]
  // Using ECC Level L for maximum data capacity
  const VERSIONS = [
    null,
    [1, 26, 7, 1],      // v1: 17 bytes
    [2, 44, 10, 1],     // v2: 32 bytes
    [3, 70, 15, 1],     // v3: 53 bytes
    [4, 100, 20, 1],    // v4: 78 bytes
    [5, 134, 26, 1],    // v5: 106 bytes
    [6, 172, 18, 2],    // v6: 134 bytes
    [7, 196, 20, 2],    // v7: 154 bytes
    [8, 242, 24, 2],    // v8: 192 bytes
    [9, 292, 30, 2],    // v9: 230 bytes
    [10, 346, 18, 4],   // v10: 274 bytes
  ];

  // Alignment pattern positions
  const ALIGN_POS = [
    null, [], [6,18], [6,22], [6,26], [6,30],
    [6,34], [6,22,38], [6,24,42], [6,26,46], [6,28,50]
  ];

  function selectVersion(dataLen) {
    for (let v = 1; v <= 10; v++) {
      const [, total, ecc, blocks] = VERSIONS[v];
      const dataCapacity = total - ecc * blocks;
      if (dataLen + 3 <= dataCapacity) return v; // +3 for mode + length + terminator overhead
    }
    return 10;
  }

  function encodeData(text, version) {
    const [, totalCW, eccPerBlock, numBlocks] = VERSIONS[version];
    const dataCW = totalCW - eccPerBlock * numBlocks;

    // Byte mode encoding
    const utf8 = new TextEncoder().encode(text);
    const bits = [];

    function pushBits(val, len) {
      for (let i = len - 1; i >= 0; i--)
        bits.push((val >> i) & 1);
    }

    // Mode indicator: 0100 (byte mode)
    pushBits(0b0100, 4);
    // Character count
    const ccBits = version <= 9 ? 8 : 16;
    pushBits(utf8.length, ccBits);
    // Data
    for (const b of utf8) pushBits(b, 8);
    // Terminator
    const maxBits = dataCW * 8;
    const termLen = Math.min(4, maxBits - bits.length);
    pushBits(0, termLen);
    // Pad to byte boundary
    while (bits.length % 8) bits.push(0);
    // Pad bytes
    let padByte = 0;
    while (bits.length < maxBits) {
      pushBits(padByte ? 0x11 : 0xEC, 8);
      padByte ^= 1;
    }

    // Convert bits to bytes
    const dataBytes = new Uint8Array(dataCW);
    for (let i = 0; i < dataCW; i++) {
      let byte = 0;
      for (let b = 0; b < 8; b++)
        byte = (byte << 1) | (bits[i * 8 + b] || 0);
      dataBytes[i] = byte;
    }

    // Split into blocks and compute ECC
    const gen = genPoly(eccPerBlock);
    const blockSize = Math.floor(dataCW / numBlocks);
    const extraBlocks = dataCW % numBlocks;
    const dataBlocks = [];
    const eccBlocks = [];
    let offset = 0;

    for (let i = 0; i < numBlocks; i++) {
      const size = blockSize + (i >= numBlocks - extraBlocks ? 1 : 0);
      const block = dataBytes.slice(offset, offset + size);
      dataBlocks.push(block);
      eccBlocks.push(polyRemainder(block, gen));
      offset += size;
    }

    // Interleave data blocks
    const result = [];
    const maxBlockLen = blockSize + (extraBlocks ? 1 : 0);
    for (let i = 0; i < maxBlockLen; i++)
      for (const block of dataBlocks)
        if (i < block.length) result.push(block[i]);
    // Interleave ECC blocks
    for (let i = 0; i < eccPerBlock; i++)
      for (const block of eccBlocks)
        if (i < block.length) result.push(block[i]);

    return new Uint8Array(result);
  }

  function createMatrix(version) {
    const size = version * 4 + 17;
    const matrix = Array.from({ length: size }, () => new Int8Array(size)); // 0=empty, 1=black, -1=white
    const reserved = Array.from({ length: size }, () => new Uint8Array(size)); // 1=reserved

    function setModule(r, c, val) {
      if (r >= 0 && r < size && c >= 0 && c < size) {
        matrix[r][c] = val ? 1 : -1;
        reserved[r][c] = 1;
      }
    }

    // Finder patterns
    function drawFinder(row, col) {
      for (let dr = -1; dr <= 7; dr++)
        for (let dc = -1; dc <= 7; dc++) {
          const r = row + dr, c = col + dc;
          if (r < 0 || r >= size || c < 0 || c >= size) continue;
          const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
          const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          setModule(r, c, inInner || (inOuter && onBorder));
        }
    }

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      setModule(6, i, i % 2 === 0);
      setModule(i, 6, i % 2 === 0);
    }

    // Alignment patterns
    const positions = ALIGN_POS[version];
    if (positions.length > 0) {
      for (const r of positions) {
        for (const c of positions) {
          if (reserved[r][c]) continue;
          for (let dr = -2; dr <= 2; dr++)
            for (let dc = -2; dc <= 2; dc++) {
              const black = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
              setModule(r + dr, c + dc, black);
            }
        }
      }
    }

    // Dark module
    setModule(size - 8, 8, true);

    // Reserve format info areas
    for (let i = 0; i < 8; i++) {
      if (!reserved[8][i]) { reserved[8][i] = 1; matrix[8][i] = 0; }
      if (!reserved[8][size - 1 - i]) { reserved[8][size - 1 - i] = 1; matrix[8][size - 1 - i] = 0; }
      if (!reserved[i][8]) { reserved[i][8] = 1; matrix[i][8] = 0; }
      if (!reserved[size - 1 - i][8]) { reserved[size - 1 - i][8] = 1; matrix[size - 1 - i][8] = 0; }
    }
    if (!reserved[8][8]) { reserved[8][8] = 1; matrix[8][8] = 0; }

    return { matrix, reserved, size };
  }

  function placeData(matrix, reserved, size, data) {
    const bits = [];
    for (const byte of data)
      for (let i = 7; i >= 0; i--)
        bits.push((byte >> i) & 1);

    let bitIdx = 0;
    let upward = true;

    for (let col = size - 1; col >= 0; col -= 2) {
      if (col === 6) col = 5; // Skip timing column
      const rows = upward ? [...Array(size).keys()].reverse() : [...Array(size).keys()];
      for (const row of rows) {
        for (let dc = 0; dc <= 1; dc++) {
          const c = col - dc;
          if (c < 0 || reserved[row][c]) continue;
          matrix[row][c] = bitIdx < bits.length && bits[bitIdx] ? 1 : -1;
          bitIdx++;
        }
      }
      upward = !upward;
    }
  }

  function applyMask(matrix, reserved, size, maskNum) {
    const maskFn = [
      (r, c) => (r + c) % 2 === 0,
      (r, c) => r % 2 === 0,
      (r, c) => c % 3 === 0,
      (r, c) => (r + c) % 3 === 0,
      (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
      (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
      (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
      (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
    ][maskNum];

    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++)
        if (!reserved[r][c] && maskFn(r, c))
          matrix[r][c] = matrix[r][c] === 1 ? -1 : 1;
  }

  function writeFormatInfo(matrix, size, maskNum) {
    // ECC Level L = 01, mask pattern
    const eccL = 0b01;
    let data = (eccL << 3) | maskNum;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) & 1 ? 0x537 : 0);
    const bits = ((data << 10) | rem) ^ 0x5412;

    // Place format bits
    const positions1 = [
      [8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],
      [7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]
    ];
    const positions2 = [
      [size-1,8],[size-2,8],[size-3,8],[size-4,8],[size-5,8],[size-6,8],[size-7,8],
      [8,size-8],[8,size-7],[8,size-6],[8,size-5],[8,size-4],[8,size-3],[8,size-2],[8,size-1]
    ];

    for (let i = 0; i < 15; i++) {
      const bit = (bits >> i) & 1;
      const [r1, c1] = positions1[i];
      const [r2, c2] = positions2[i];
      matrix[r1][c1] = bit ? 1 : -1;
      matrix[r2][c2] = bit ? 1 : -1;
    }
  }

  function scorePenalty(matrix, size) {
    let penalty = 0;
    // Rule 1: runs of same color
    for (let r = 0; r < size; r++) {
      let count = 1;
      for (let c = 1; c < size; c++) {
        if (matrix[r][c] === matrix[r][c-1]) {
          count++;
          if (count === 5) penalty += 3;
          else if (count > 5) penalty++;
        } else count = 1;
      }
    }
    for (let c = 0; c < size; c++) {
      let count = 1;
      for (let r = 1; r < size; r++) {
        if (matrix[r][c] === matrix[r-1][c]) {
          count++;
          if (count === 5) penalty += 3;
          else if (count > 5) penalty++;
        } else count = 1;
      }
    }
    return penalty;
  }

  function generate(text) {
    const version = selectVersion(new TextEncoder().encode(text).length);
    const codewords = encodeData(text, version);
    const { matrix, reserved, size } = createMatrix(version);
    placeData(matrix, reserved, size, codewords);

    // Try all masks, pick best
    let bestMask = 0, bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      const testMatrix = matrix.map(r => Int8Array.from(r));
      const testReserved = reserved.map(r => Uint8Array.from(r));
      applyMask(testMatrix, testReserved, size, m);
      writeFormatInfo(testMatrix, size, m);
      const score = scorePenalty(testMatrix, size);
      if (score < bestScore) { bestScore = score; bestMask = m; }
    }

    applyMask(matrix, reserved, size, bestMask);
    writeFormatInfo(matrix, size, bestMask);

    return { matrix, size };
  }

  function toCanvas(text, options = {}) {
    const { matrix, size } = generate(text);
    const scale = options.scale || Math.max(4, Math.floor(200 / size));
    const margin = options.margin ?? 2;
    const totalSize = (size + margin * 2) * scale;
    const darkColor = options.dark || '#EEEEF0';
    const lightColor = options.light || '#1A1A2E';

    const canvas = document.createElement('canvas');
    canvas.width = totalSize;
    canvas.height = totalSize;
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = lightColor;
    ctx.fillRect(0, 0, totalSize, totalSize);

    // Modules
    ctx.fillStyle = darkColor;
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++)
        if (matrix[r][c] === 1)
          ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);

    return canvas;
  }

  return { generate, toCanvas };
})();
