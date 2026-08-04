export type Rng = () => number;

export function hashSeed(input: string): number {
  let hash = 2166136261;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;

  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomRange(rng: Rng, min: number, max: number): number {
  return min + (max - min) * rng();
}

export function randomInt(rng: Rng, min: number, max: number): number {
  return Math.floor(randomRange(rng, min, max + 1));
}

export function sample<T>(rng: Rng, values: T[]): T {
  return values[randomInt(rng, 0, values.length - 1)]!;
}
