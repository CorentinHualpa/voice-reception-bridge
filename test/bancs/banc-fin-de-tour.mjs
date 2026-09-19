// LA COURBE QUI DÉCIDE : pour un délai d'attente donné, combien de fois coupe-t-on quelqu'un qui n'avait pas
// fini de parler ? C'est le seul arbitrage qui compte en fin de tour, et c'est le protocole du benchmark ouvert
// de LiveKit (eot-bench) transposé à notre pont et à des phrases françaises.
//
// Deux mesures, et elles s'opposent :
//   LATENCE       sur une phrase TERMINÉE, le temps entre le dernier mot et la décision de répondre. C'est de
//                 l'attente pure, payée sur chaque tour de chaque appel.
//   COUPURE       sur une pause suivie d'une reprise, le fait d'avoir décidé de répondre pendant la pause.
//                 C'est couper la parole à un client qui hésite, et ça s'entend bien plus qu'une seconde d'attente.
//
// Le banc rejoue les fixtures de `fabriquer-pauses.mjs` à travers la MÊME logique de détection que le pont
// (seuil d'énergie adaptatif au plancher de bruit, fenêtre de voix, silence de fin de tour), en balayant le
// délai. Il donne la courbe d'aujourd'hui, celle qu'un modèle de fin de tour devra battre.
//
// Usage : node test/bancs/banc-fin-de-tour.mjs [delais separes par des virgules]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const DOSSIER = path.join(ICI, "fixtures", "pauses");
const index = JSON.parse(fs.readFileSync(path.join(DOSSIER, "pauses.json"), "utf8"));
const DELAIS = (process.argv[2] || "300,400,500,600,700,800,900,1000,1200,1500").split(",").map(Number);

// Réglages repris du pont, à l'identique.
const SEUIL_SON_RMS = 600;
const FENETRE_VOIX_MS = 1500;   // fenêtre glissante sur laquelle on compte la voix
const PAQUET_MS = 20;

function rms(pcm, de, a) {
  let s = 0;
  const n = a - de;
  for (let i = de; i < a; i++) { const v = pcm.readInt16LE(i * 2); s += v * v; }
  return Math.sqrt(s / Math.max(1, n));
}

// Rejoue un fichier et rend les instants où le pont aurait décidé « le client a fini », pour un délai donné.
function decisions(pcm, finDeTourMs) {
  const parPaquet = (PAQUET_MS / 1000) * 8000;
  const total = Math.floor(pcm.length / 2 / parPaquet);
  const niveaux = []; // plancher de bruit glissant, comme dans le pont
  let seuil = SEUIL_SON_RMS;
  let tour = null; // { derniereVoixMs }
  const out = [];
  for (let k = 0; k < total; k++) {
    const t = k * PAQUET_MS;
    const r = rms(pcm, Math.round(k * parPaquet), Math.round((k + 1) * parPaquet));
    niveaux.push(r);
    if (niveaux.length > 250) niveaux.shift(); // 5 s
    if (niveaux.length >= 50 && k % 25 === 0) {
      const tri = niveaux.slice().sort((a, b) => a - b);
      seuil = Math.min(1200, Math.max(SEUIL_SON_RMS, tri[Math.floor(niveaux.length * 0.1)] * 2));
    }
    const voix = r >= seuil;
    if (voix) { if (!tour) tour = { derniereVoixMs: t }; else tour.derniereVoixMs = t; }
    else if (tour && t - tour.derniereVoixMs >= finDeTourMs) {
      out.push({ decideMs: t, finParoleMs: tour.derniereVoixMs });
      tour = null;
    }
  }
  return out;
}

console.log(`${index.cas.length} cas, ${index.cas.filter((c) => c.famille === "fini").length} phrases terminées, ` +
  `${index.cas.reduce((s, c) => s + c.reperes.filter((r) => r.suite).length, 0)} pauses suivies d'une reprise\n`);
console.log("délai   latence médiane   latence p90   coupures        détail des coupures");
console.log("─".repeat(100));

const resultats = [];
for (const delai of DELAIS) {
  const latences = [];
  let coupures = 0, pausesTotal = 0;
  const qui = [];
  for (const cas of index.cas) {
    const pcm = fs.readFileSync(path.join(DOSSIER, cas.fichier)).subarray(44);
    const dec = decisions(pcm, delai);
    for (let i = 0; i < cas.reperes.length; i++) {
      const r = cas.reperes[i];
      if (r.suite) {
        pausesTotal++;
        // Couper = avoir décidé PENDANT la pause, c'est-à-dire entre la fin de ce segment et le DÉBUT du
        // suivant. Prendre la fin du suivant compterait comme coupure toute décision postérieure à sa parole.
        const debutReprise = cas.reperes[i + 1]?.debutParoleMs ?? cas.dureeMs;
        if (dec.some((d) => d.decideMs > r.finParoleMs && d.decideMs < debutReprise)) { coupures++; qui.push(cas.id); }
      } else if (cas.famille === "fini") {
        // Latence depuis la VÉRITÉ TERRAIN (la fin de parole du générateur), pas depuis notre propre détection :
        // la queue d'un segment de synthèse descend sous le seuil avant de se taire vraiment, et mesurer depuis
        // notre détection donnait des latences plus courtes que le délai lui-même, ce qui est absurde.
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
  console.log(`${String(delai).padStart(5)} ms ${String(med).padStart(12)} ms ${String(p90).padStart(11)} ms   ` +
    `${String(coupures + "/" + pausesTotal).padStart(6)} (${String(pct).padStart(3)} %)   ${uniques.slice(0, 4).join(", ")}${uniques.length > 4 ? ", …" : ""}`);
  resultats.push({ delai, med, p90, coupures, pausesTotal, pct });
}

console.log("\nLecture : la latence est payée sur CHAQUE tour, la coupure seulement quand le client hésite.");
console.log("Le pont tourne aujourd'hui à 900 ms sur Palazzo et 1000 ms sur Dany.");
const ref = resultats.find((r) => r.delai === 900);
if (ref) console.log(`À 900 ms : ${ref.med} ms d'attente médiane, ${ref.coupures}/${ref.pausesTotal} coupures (${ref.pct} %).`);
console.log("Un modèle de fin de tour doit faire MIEUX sur les deux à la fois, sinon il ne sert à rien.");
