// @ts-check

export class SeededRandom {
  /** @param {number | string} seed */
  constructor(seed) {
    this.state = hashSeed(String(seed));
  }

  next() {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** @param {number} min @param {number} max */
  int(min, max) {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** @param {number} min @param {number} max */
  float(min, max) {
    return this.next() * (max - min) + min;
  }

  /** @template T @param {T[]} values */
  pick(values) {
    return values[Math.floor(this.next() * values.length)];
  }

  /** @template T @param {Array<{ value: T; weight: number }>} values */
  weighted(values) {
    const total = values.reduce((sum, item) => sum + item.weight, 0);
    let cursor = this.float(0, total);
    for (const item of values) {
      cursor -= item.weight;
      if (cursor <= 0) return item.value;
    }
    return values[values.length - 1].value;
  }

  chance(probability) {
    return this.next() < probability;
  }
}

/** @param {string} input */
function hashSeed(input) {
  let h = 1779033703 ^ input.length;
  for (let i = 0; i < input.length; i += 1) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}
