/*
Section 7 (optional, gOGig-inspired) — lightweight perceptual hash so a
photo reused across two different shops' installations can be flagged for
Admin review instead of silently accepted.

This is a standard "difference hash" (dHash): shrink the image to a tiny
9x8 grayscale grid, compare each pixel to its right-hand neighbour, and
pack the 64 true/false results into a 16-char hex string. Two visually
similar images produce identical (or very close) hashes; two different
photos essentially never collide. No new dependency — just canvas, which
every browser already has (this project also has zero image-processing
libraries today, so this keeps it that way for one small feature).

Deliberately NOT a cryptographic hash (that would only catch byte-identical
files, e.g. re-uploading the exact same JPEG) — dHash still matches a
photo that's been re-saved, slightly recompressed, or trivially cropped,
which is the realistic "reused an old photo" fraud pattern this guards
against.
*/

const HASH_SIZE = 8; // 8x8 grid -> 64 bits -> 16 hex chars

export async function computeImageHash(dataUrl: string): Promise<string | null> {
  try {
    const img = await loadImage(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = HASH_SIZE + 1;
    canvas.height = HASH_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, HASH_SIZE + 1, HASH_SIZE);
    const { data } = ctx.getImageData(0, 0, HASH_SIZE + 1, HASH_SIZE);

    // Grayscale grid
    const gray: number[][] = [];
    for (let y = 0; y < HASH_SIZE; y++) {
      const row: number[] = [];
      for (let x = 0; x < HASH_SIZE + 1; x++) {
        const i = (y * (HASH_SIZE + 1) + x) * 4;
        row.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      }
      gray.push(row);
    }

    // dHash: each bit = pixel brighter than its right neighbour
    let bits = '';
    for (let y = 0; y < HASH_SIZE; y++) {
      for (let x = 0; x < HASH_SIZE; x++) {
        bits += gray[y][x] > gray[y][x + 1] ? '1' : '0';
      }
    }

    // Pack 64 bits -> 16 hex chars
    let hex = '';
    for (let i = 0; i < bits.length; i += 4) {
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return hex;
  } catch (err) {
    console.error('[imageHash] failed to compute hash:', err);
    return null;
  }
}

// Hamming distance between two hex hashes (0 = identical, higher = more
// different). Used with a small tolerance so a slightly recompressed
// re-upload of the same photo still counts as a duplicate.
export function hammingDistance(hashA: string, hashB: string): number {
  if (hashA.length !== hashB.length) return Infinity;
  let distance = 0;
  for (let i = 0; i < hashA.length; i++) {
    const diff = parseInt(hashA[i], 16) ^ parseInt(hashB[i], 16);
    distance += bitCount4(diff);
  }
  return distance;
}

function bitCount4(n: number): number {
  let count = 0;
  while (n) { count += n & 1; n >>= 1; }
  return count;
}

// A hamming distance up to this many bits (out of 64) still counts as
// "the same photo" for duplicate-flagging purposes.
export const DUPLICATE_HASH_THRESHOLD = 6;

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}
