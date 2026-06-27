// Transcodage audio entre Twilio (G.711 mu-law 8kHz) et Grok Voice (PCM16 a un rate configurable).
// Si GROK_RATE === 8000, aucun resampling : on ne fait que coder/decoder le mu-law (le plus fiable).
// Sinon, resampling lineaire (suffisant pour de la voix telephone).

// --- Codec G.711 mu-law (par echantillon) ---
export function ulawDecodeSample(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exp = (u >> 4) & 0x07;
  const mant = u & 0x0f;
  let s = (((mant << 3) + 0x84) << exp) - 0x84;
  return sign ? -s : s;
}

export function ulawEncodeSample(s) {
  const BIAS = 0x84, CLIP = 32635;
  let sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exp = 7;
  for (let m = 0x4000; (s & m) === 0 && exp > 0; exp--, m >>= 1) {}
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}

// --- Resampling lineaire ---
function resampleLinear(src, from, to) {
  if (from === to) return src;
  const ratio = to / from;
  const n = Math.max(1, Math.round(src.length * ratio));
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / ratio;
    const i0 = Math.floor(x);
    const f = x - i0;
    const a = src[i0] || 0;
    const b = src[i0 + 1] !== undefined ? src[i0 + 1] : a;
    out[i] = (a + (b - a) * f) | 0;
  }
  return out;
}

// mu-law 8k (Buffer recu de Twilio) -> PCM16 (Buffer) au rate Grok
export function ulaw8kToPcm16(ulawBuf, grokRate) {
  const pcm8 = new Int16Array(ulawBuf.length);
  for (let i = 0; i < ulawBuf.length; i++) pcm8[i] = ulawDecodeSample(ulawBuf[i]);
  const pcm = resampleLinear(pcm8, 8000, grokRate);
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

// PCM16 (Buffer recu de Grok) au rate Grok -> mu-law 8k (Buffer a envoyer a Twilio)
export function pcm16ToUlaw8k(pcmBuf, grokRate) {
  const pcm = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, Math.floor(pcmBuf.byteLength / 2));
  const pcm8 = resampleLinear(pcm, grokRate, 8000);
  const out = Buffer.alloc(pcm8.length);
  for (let i = 0; i < pcm8.length; i++) out[i] = ulawEncodeSample(pcm8[i]);
  return out;
}
