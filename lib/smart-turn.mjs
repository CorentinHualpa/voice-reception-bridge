// Port Node.js pur du pre-traitement Smart Turn v3 (Whisper log-mel) + inference ONNX.
import fs from "node:fs";
import * as ort from "onnxruntime-node";

const SR = 16000, N_FFT = 400, HOP = 160, N_MELS = 80, N_SAMPLES = 8 * SR, N_FRAMES = 800;
const N_BINS = N_FFT / 2 + 1; // 201

// ---------- banc de filtres mel (Slaney), identique a transformers ----------
function hzToMel(f) {
  const minLogHz = 1000.0, minLogMel = 15.0, logstep = 27.0 / Math.log(6.4);
  return f >= minLogHz ? minLogMel + Math.log(f / minLogHz) * logstep : 3.0 * f / 200.0;
}
function melToHz(m) {
  const minLogHz = 1000.0, minLogMel = 15.0, logstep = Math.log(6.4) / 27.0;
  return m >= minLogMel ? minLogHz * Math.exp(logstep * (m - minLogMel)) : 200.0 * m / 3.0;
}
function buildMelFilters() {
  const melMin = hzToMel(0), melMax = hzToMel(SR / 2);
  const filterFreqs = new Float64Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) filterFreqs[i] = melToHz(melMin + (melMax - melMin) * i / (N_MELS + 1));
  const fftFreqs = new Float64Array(N_BINS);
  for (let i = 0; i < N_BINS; i++) fftFreqs[i] = (SR / 2) * i / (N_BINS - 1);
  const diff = new Float64Array(N_MELS + 1);
  for (let i = 0; i < N_MELS + 1; i++) diff[i] = filterFreqs[i + 1] - filterFreqs[i];
  // stockage transpose : [mel][bin]
  const F = new Float64Array(N_MELS * N_BINS);
  for (let m = 0; m < N_MELS; m++) {
    const enorm = 2.0 / (filterFreqs[m + 2] - filterFreqs[m]);
    for (let b = 0; b < N_BINS; b++) {
      const down = -(filterFreqs[m] - fftFreqs[b]) / diff[m];
      const up = (filterFreqs[m + 2] - fftFreqs[b]) / diff[m + 1];
      F[m * N_BINS + b] = Math.max(0, Math.min(down, up)) * enorm;
    }
  }
  return F;
}
const MEL = buildMelFilters();

// fenetre de Hann periodique : np.hanning(401)[:400]
const WIN = new Float64Array(N_FFT);
for (let i = 0; i < N_FFT; i++) WIN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);

// ---------- FFT 400 points = 16 x DFT(25) + 4 etages radix-2 ----------
const LEAF = 25, GROUPS = 16;
const rev4 = (g) => ((g & 1) << 3) | ((g & 2) << 1) | ((g & 4) >> 1) | ((g & 8) >> 3);
const LEAF_COS = new Float64Array(LEAF * LEAF), LEAF_SIN = new Float64Array(LEAF * LEAF);
for (let k = 0; k < LEAF; k++) for (let j = 0; j < LEAF; j++) {
  const a = (-2 * Math.PI * k * j) / LEAF;
  LEAF_COS[k * LEAF + j] = Math.cos(a); LEAF_SIN[k * LEAF + j] = Math.sin(a);
}
const STAGES = [];
for (let s = 1; s <= 4; s++) {
  const half = LEAF * (1 << (s - 1)), size = half * 2;
  const c = new Float64Array(half), sn = new Float64Array(half);
  for (let k = 0; k < half; k++) { const a = (-2 * Math.PI * k) / size; c[k] = Math.cos(a); sn[k] = Math.sin(a); }
  STAGES.push({ half, size, c, sn });
}
const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
const tr = new Float64Array(N_FFT), ti = new Float64Array(N_FFT);

// x : Float64Array de N_FFT echantillons deja fenetres. Remplit re/im avec la FFT.
function fft400(x) {
  for (let g = 0; g < GROUPS; g++) {
    const off = rev4(g), base = g * LEAF;
    for (let k = 0; k < LEAF; k++) {
      let sr = 0, si = 0;
      for (let j = 0; j < LEAF; j++) {
        const v = x[off + j * GROUPS];
        sr += v * LEAF_COS[k * LEAF + j];
        si += v * LEAF_SIN[k * LEAF + j];
      }
      re[base + k] = sr; im[base + k] = si;
    }
  }
  let src = { re, im }, dst = { re: tr, im: ti };
  for (const st of STAGES) {
    const { half, size, c, sn } = st;
    for (let b = 0; b < N_FFT; b += size) {
      for (let k = 0; k < half; k++) {
        const er = src.re[b + k], ei = src.im[b + k];
        const orr = src.re[b + half + k], oi = src.im[b + half + k];
        const wr = c[k] * orr - sn[k] * oi, wi = c[k] * oi + sn[k] * orr;
        dst.re[b + k] = er + wr; dst.im[b + k] = ei + wi;
        dst.re[b + half + k] = er - wr; dst.im[b + half + k] = ei - wi;
      }
    }
    const t = src; src = dst; dst = t;
  }
  return src;
}

// ---------- features ----------
const padded = new Float64Array(N_SAMPLES + N_FFT);
const frame = new Float64Array(N_FFT);
const power = new Float64Array(N_BINS);
const logMel = new Float32Array(N_MELS * N_FRAMES);

/** audio : Float32Array de 128000 echantillons a 16 kHz, deja tronque/padde. */
export function computeFeatures(audio, doNormalize = true) {
  let x = audio;
  if (doNormalize) {
    let mean = 0; for (let i = 0; i < N_SAMPLES; i++) mean += audio[i];
    mean /= N_SAMPLES;
    let v = 0; for (let i = 0; i < N_SAMPLES; i++) { const d = audio[i] - mean; v += d * d; }
    v /= N_SAMPLES;
    const inv = 1 / Math.sqrt(v + 1e-7);
    x = new Float32Array(N_SAMPLES);
    for (let i = 0; i < N_SAMPLES; i++) x[i] = (audio[i] - mean) * inv;
  }
  const pad = N_FFT / 2; // 200, reflect
  for (let i = 0; i < pad; i++) padded[i] = x[pad - i];
  for (let i = 0; i < N_SAMPLES; i++) padded[pad + i] = x[i];
  for (let i = 0; i < pad; i++) padded[pad + N_SAMPLES + i] = x[N_SAMPLES - 2 - i];

  let maxLog = -Infinity;
  for (let f = 0; f < N_FRAMES; f++) {
    const off = f * HOP;
    for (let i = 0; i < N_FFT; i++) frame[i] = padded[off + i] * WIN[i];
    const S = fft400(frame);
    for (let b = 0; b < N_BINS; b++) power[b] = S.re[b] * S.re[b] + S.im[b] * S.im[b];
    for (let m = 0; m < N_MELS; m++) {
      let acc = 0; const row = m * N_BINS;
      for (let b = 0; b < N_BINS; b++) acc += MEL[row + b] * power[b];
      const lv = Math.log10(Math.max(1e-10, acc));
      if (lv > maxLog) maxLog = lv;
      logMel[m * N_FRAMES + f] = lv;
    }
  }
  const floor = maxLog - 8.0;
  for (let i = 0; i < logMel.length; i++) logMel[i] = (Math.max(logMel[i], floor) + 4.0) / 4.0;
  return logMel; // (80, 800) aplati, ordre ligne-majeur
}

/** Tronque aux 8 dernieres secondes, ou pad de zeros AU DEBUT. */
export function fitWindow(pcmFloat32) {
  if (pcmFloat32.length === N_SAMPLES) return pcmFloat32;
  const out = new Float32Array(N_SAMPLES);
  if (pcmFloat32.length > N_SAMPLES) out.set(pcmFloat32.subarray(pcmFloat32.length - N_SAMPLES));
  else out.set(pcmFloat32, N_SAMPLES - pcmFloat32.length);
  return out;
}

export async function loadModel(path, threads = 1) {
  return ort.InferenceSession.create(path, {
    executionMode: "sequential",
    interOpNumThreads: 1,
    intraOpNumThreads: threads,
    graphOptimizationLevel: "all",
  });
}

export async function predict(session, pcmFloat32) {
  const feats = computeFeatures(fitWindow(pcmFloat32), true);
  const tensor = new ort.Tensor("float32", feats, [1, N_MELS, N_FRAMES]);
  const out = await session.run({ input_features: tensor });
  return out.logits.data[0]; // deja passe par un Sigmoid dans le graphe : c'est une probabilite
}
