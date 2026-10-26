/**
 * rng.js —— 可复现的伪随机数
 * 存档里只存一个整数种子，读档后 AI 行为完全一致（方便调试与回放）。
 */

export function nextRandom(state) {
  let t = (state.rng = (state.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randomInt(state, max) {
  return Math.floor(nextRandom(state) * max);
}
