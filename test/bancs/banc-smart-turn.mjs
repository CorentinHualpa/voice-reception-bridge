// Smart Turn v3 contre notre seuil de silence, sur EXACTEMENT le même jeu d'épreuve et avec exactement les
// deux mêmes mesures que `banc-fin-de-tour.mjs`. C'est le seul test qui tranche : s'il ne bat pas 880 ms
// d'attente ET 13 % de coupures en même temps, il ne sert à rien et on le jette.
//
// Déroulé simulé, celui de Pipecat : un VAD d'énergie (le nôtre, à l'identique) surveille la parole ; dès qu'il
// voit `VAD_MS` de silence, on donne au modèle les 8 dernières secondes et on lui demande si le tour est fini.
// S'il dit non, on continue d'écouter et on le redemande au palier de silence suivant. Un filet ferme le tour
// d'office au-delà de `REPLI_MS`, sinon un faux négatif coûte un blanc entier.
//
// ⚠ Le modèle répond « fin de tour » à presque tout ce qui n'est pas de la parole (mesuré : 0,94 à 0,99 sur du
// silence pur). Il SUPPOSE un VAD en amont et ne le remplace pas.
//
// Usage : node test/bancs/banc-smart-turn.mjs [seuils separes par des virgules] [vad_ms]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadModel, predict } from "../../lib/smart-turn.mjs";
import { pcm8kVers16k } from "../../lib/telephone-16k.js";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const DOSSIER = path.join(ICI, "fixtures", "pauses");
const MODELE = path.join(ICI, "../../lib/modeles/smart-turn-v3.2-cpu.onnx");
const index = JSON.parse(fs.readFileSync(path.join(DOSSIER, "pauses.json"), "utf8"));
const SEUILS = (process.argv[2] || "0.5,0.6,0.7,0.8").split(",").map(Number);
const VAD_MS = Number(process.argv[3] || 200);   // silence qui déclenche une interrogation du modèle
const REPLI_MS = 1500;                            // filet : au-delà, fin de tour quoi qu'il dise
const PAQUET_MS = 20, SEUIL_SON_RMS = 600;

function rms(pcm, de, a) {
  let s = 0;
  for (let i = de; i < a; i++) { const v = pcm.readInt16LE(i * 2); s += v * v; }
  return Math.sqrt(s / Math.max(1, a - de));
}

// Rejoue un fichier au rythme réel et rend les instants de décision, en interrogeant le modèle.
async function decisions(session, pcm, seuil) {
  const par = (PAQUET_MS / 1000) * 8000;
  const total = Math.floor(pcm.length / 2 / par);
  const niveaux = [];
  let seuilVoix = SEUIL_SON_RMS, tour = null, dejaDemandeA = -1;
  const out = [];
  let audio16 = new Float32Array(0), queue = null;
  for (let k = 0; k < total; k++) {
    const t = k * PAQUET_MS;
    const bloc = pcm.subarray(Math.round(k * par) * 2, Math.round((k + 1) * par) * 2);
    const { pcm: bloc16, queue: q } = pcm8kVers16k(bloc, queue);
    queue = q;
    const fusion = new Float32Array(audio16.length + bloc16.length);
    fusion.set(audio16); fusion.set(bloc16, audio16.length);
    audio16 = fusion.length > 16000 * 8 ? fusion.subarray(fusion.length - 16000 * 8).slice() : fusion;

    const r = rms(pcm, Math.round(k * par), Math.round((k + 1) * par));
    niveaux.push(r);
    if (niveaux.length > 250) niveaux.shift();
    if (niveaux.length >= 50 && k % 25 === 0) {
      const tri = niveaux.slice().sort((a, b) => a - b);
      seuilVoix = Math.min(1200, Math.max(SEUIL_SON_RMS, tri[Math.floor(niveaux.length * 0.1)] * 2));
    }
    const voix = r >= seuilVoix;
    if (voix) { tour = { derniereVoixMs: t }; dejaDemandeA = -1; continue; }
    if (!tour) continue;
    const silence = t - tour.derniereVoixMs;
    if (silence >= REPLI_MS) { out.push({ decideMs: t, p: null, repli: true }); tour = null; continue; }
    // On interroge au premier palier, puis tous les 200 ms tant qu'il dit « pas fini ».
    if (silence >= VAD_MS && (dejaDemandeA < 0 || t - dejaDemandeA >= 200)) {
      dejaDemandeA = t;
      const p = await predict(session, audio16);
      if (p > seuil) { out.push({ decideMs: t, p, repli: false }); tour = null; }
    }
  }
  return out;
}

const session = await loadModel(MODELE, 4);
console.log(`Smart Turn v3.2 int8, VAD à ${VAD_MS} ms, repli à ${REPLI_MS} ms, ${index.cas.length} cas\n`);
console.log("seuil   latence médiane   latence p90   coupures        replis   détail des coupures");
console.log("─".repeat(105));

for (const seuil of SEUILS) {
  const latences = [];
  let coupures = 0, pausesTotal = 0, replis = 0;
  const qui = [];
  for (const cas of index.cas) {
    const pcm = fs.readFileSync(path.join(DOSSIER, cas.fichier)).subarray(44);
    const dec = await decisions(session, pcm, seuil);
    replis += dec.filter((d) => d.repli).length;
    for (let i = 0; i < cas.reperes.length; i++) {
      const r = cas.reperes[i];
      if (r.suite) {
        pausesTotal++;
        const debutReprise = cas.reperes[i + 1]?.debutParoleMs ?? cas.dureeMs;
        if (dec.some((d) => d.decideMs > r.finParoleMs && d.decideMs < debutReprise)) { coupures++; qui.push(cas.id); }
      } else if (cas.famille === "fini") {
        const d = dec.find((x) => x.decideMs >= r.finParoleMs);
        if (d) latences.push(d.decideMs - r.finParoleMs);
      }
    }
  }
  const tri = latences.slice().sort((a, b) => a - b);
  const med = tri[tri.length >> 1] ?? 0;
  const p90 = tri[Math.min(tri.length - 1, Math.floor(tri.length * 0.9))] ?? 0;
  const pct = Math.round((100 * coupures) / Math.max(1, pausesTotal));
  const uniques = [...new Set(qui)];
  console.log(`${String(seuil).padStart(5)}  ${String(med).padStart(12)} ms ${String(p90).padStart(11)} ms   ` +
    `${String(coupures + "/" + pausesTotal).padStart(6)} (${String(pct).padStart(3)} %)   ${String(replis).padStart(6)}   ` +
    `${uniques.slice(0, 3).join(", ")}${uniques.length > 3 ? ", …" : ""}`);
}

console.log("\nÀ battre, seuil de silence seul (banc-fin-de-tour.mjs) :");
console.log("  900 ms (la production) : 880 ms d'attente, 13 % de coupures");
console.log("  700 ms                 : 680 ms d'attente, 31 % de coupures");
console.log("Un « repli » est un tour que le modèle n'a jamais jugé fini : c'est un blanc de 1,5 s pour le client.");
process.exit(0);
