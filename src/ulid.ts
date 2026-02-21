// ---------------------------------------------------------------------------
// BrowserClaw — ULID generator (no dependencies)
// ---------------------------------------------------------------------------

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = 0;
let lastRandom: number[] = [];

/**
 * Generate a ULID (Universally Unique Lexicographically Sortable Identifier).
 * Monotonically increasing within the same millisecond.
 */
export function ulid(): string {
  const now = Date.now();

  if (now === lastTime) {
    // Increment random component
    for (let i = lastRandom.length - 1; i >= 0; i--) {
      if (lastRandom[i] < ENCODING_LEN - 1) {
        lastRandom[i]++;
        break;
      }
      lastRandom[i] = 0;
    }
  } else {
    lastTime = now;
    lastRandom = Array.from(
      crypto.getRandomValues(new Uint8Array(RANDOM_LEN)),
      (b) => b % ENCODING_LEN,
    );
  }

  // Encode time
  let time = now;
  const timeChars: string[] = new Array(TIME_LEN);
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    timeChars[i] = ENCODING[time % ENCODING_LEN];
    time = Math.floor(time / ENCODING_LEN);
  }

  // Encode random
  const randomChars = lastRandom.map((r) => ENCODING[r]);

  return timeChars.join('') + randomChars.join('');
}
