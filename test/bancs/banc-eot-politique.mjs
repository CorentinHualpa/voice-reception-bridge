// L'ARBITRAGE, en une table : pour un réglage donné, combien de temps fait-on attendre quelqu'un qui a fini
// de parler, et combien de fois coupe-t-on quelqu'un qui n'avait pas fini ? Tout le chantier tient là-dedans.
//
// Ce banc ne fait aucune inférence : il rejoue les probabilités écrites par `banc-eot-scores.mjs` à travers
// toutes les politiques possibles, et il y ajoute la SEULE référence qui compte, le détecteur du pont
// d'aujourd'hui, rejoué sur les mêmes 400 tours réels.
//
// Une politique a trois manettes, comme chez LiveKit :
//   seuil     la probabilité à partir de laquelle on considère que le client a fini
//   delai     le silence minimum avant d'avoir le droit d'agir sur le modèle (il se paie sur CHAQUE tour)
//   filet     le silence au bout duquel on répond de toute façon, même si le modèle n'a rien dit
//
// Le pont d'aujourd'hui est le cas particulier « pas de modèle, filet à 900 ms ».
//
// Usage : node test/bancs/banc-eot-politique.mjs [--bande=telephone|large|les-deux]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(ICI, "fixtures", "eot-livekit");
const SORTIES = path.join(ICI, "../../.sorties");
const arg = (nom, defaut) => (process.argv.find((a) => a.startsWith(`--${nom}=`)) || `=${defaut}`).split("=").pop();
const BANDES = arg("bande", "les-deux") === "les-deux" ? ["telephone", "large"] : [arg("bande", "telephone")];

const SEUILS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.93, 0.95, 0.97, 0.98, 0.99];
const FILETS = [600, 800, 900, 1000, 1200, 1500, 2000, 3000];

const mediane = (xs) => { const t = xs.slice().sort((a, b) => a - b); return t.length ? t[Math.floor(t.length / 2)] : NaN; };
const quantile = (xs, q) => { const t = xs.slice().sort((a, b) => a - b); return t.length ? t[Math.min(t.length - 1, Math.floor(t.length * q))] : NaN; };

// ---------- 1. la référence : le détecteur du pont, sur les vrais tours ----------

// Réglages repris du pont, à l'identique (voir banc-fin-de-tour.mjs).
const SEUIL_SON_RMS = 600, PAQUET_MS = 20;

function lireWav16k(fichier) {
  const buf = fs.readFileSync(fichier);
  let off = 12;
  while (off < buf.length - 8) {
    const id = buf.toString("ascii", off, off + 4);
    const taille = buf.readUInt32LE(off + 4);
    if (id === "data") return buf.subarray(off + 8, off + 8 + taille);
    off += 8 + taille + (taille & 1);
  }
  throw new Error("pas de chunk data : " + fichier);
}

/** 16 kHz PCM16 -> 8 kHz PCM16, comme la ligne : un échantillon sur deux après passe-bas grossier. */
function vers8k(pcm16k) {
  const n = Math.floor(pcm16k.length / 2 / 2);
  const out = Buffer.allocUnsafe(n * 2);
  for (let i = 0; i < n; i++) {
    const a = pcm16k.readInt16LE(i * 4);
    const b = i * 4 + 2 < pcm16k.length ? pcm16k.readInt16LE(i * 4 + 2) : a;
    out.writeInt16LE(Math.round((a + b) / 2), i * 2);
  }
  return out;
}

function decisionsDuPont(pcm8k, finDeTourMs) {
  const parPaquet = (PAQUET_MS / 1000) * 8000;
  const total = Math.floor(pcm8k.length / 2 / parPaquet);
  const niveaux = [];
  let seuil = SEUIL_SON_RMS, tour = null;
  const out = [];
  for (let k = 0; k < total; k++) {
    const t = k * PAQUET_MS;
    let s = 0;
    const de = Math.round(k * parPaquet), a = Math.round((k + 1) * parPaquet);
    for (let i = de; i < a; i++) { const v = pcm8k.readInt16LE(i * 2); s += v * v; }
    const r = Math.sqrt(s / Math.max(1, a - de));
    niveaux.push(r);
    if (niveaux.length > 250) niveaux.shift();
    if (niveaux.length >= 50 && k % 25 === 0) {
      const tri = niveaux.slice().sort((x, y) => x - y);
      seuil = Math.min(1200, Math.max(SEUIL_SON_RMS, tri[Math.floor(niveaux.length * 0.1)] * 2));
    }
    if (r >= seuil) { tour = { derniereVoixMs: t }; }
    else if (tour && t - tour.derniereVoixMs >= finDeTourMs) { out.push(t); tour = null; }
  }
  return out;
}

function referencePont(tours) {
  const lignes = [];
  for (const filet of FILETS) {
    const attentes = [];
    let coupures = 0, holds = 0, jamais = 0;
    for (const tour of tours) {
      const eot = tour.spans[tour.spans.length - 1];
      holds += tour.spans.length - 1;
      // La bande son s'arrête à la fin du tour ; dans la vraie vie le silence continue, donc on prolonge
      // avec le bruit de ligne du dernier silence plutôt qu'avec du zéro numérique (qui ferait chuter le
      // plancher de bruit auquel le seuil du pont s'adapte).
      const pcm = vers8k(lireWav16k(path.join(CORPUS, tour.fichier)));
      const queue = pcm.subarray(Math.max(0, pcm.length - 1600), pcm.length);
      const rallonge = Buffer.concat([pcm, ...Array(Math.ceil((filet + 1000) / 100)).fill(queue)]);
      const d = decisionsDuPont(rallonge, filet);
      const avant = d.filter((t) => t < eot.debut * 1000);
      coupures += Math.min(avant.length, tour.spans.length - 1);
      const apres = d.find((t) => t >= eot.debut * 1000);
      if (apres === undefined) { jamais++; attentes.push(filet); }
      else attentes.push(apres - eot.debut * 1000);
    }
    lignes.push({ filet, coupures: (coupures / holds) * 100, attente: mediane(attentes), moyenne: attentes.reduce((a, b) => a + b, 0) / attentes.length, p90: quantile(attentes, 0.9), jamais });
  }
  return lignes;
}

// ---------- 2. la politique avec modèle ----------

function evaluer(tours, seuil, delai, filet) {
  const attentes = [];
  let coupures = 0, holds = 0, filets = 0;
  for (const tour of tours) {
    for (const span of tour.spans) {
      const longueurMs = (span.fin - span.debut) * 1000;
      const points = Object.keys(span.scores).map(Number).sort((a, b) => a - b).filter((d) => d >= delai);
      if (span.etiquette === "hold") {
        holds++;
        // Le filet coupe tout seul si l'hésitation dure plus longtemps que lui.
        if (filet <= longueurMs) { coupures++; continue; }
        if (points.some((d) => d <= longueurMs + 1e-6 && span.scores[d] >= seuil)) coupures++;
      } else {
        const tire = points.find((d) => span.scores[d] >= seuil);
        if (tire === undefined || tire > filet) { attentes.push(filet); filets++; }
        else attentes.push(tire);
      }
    }
  }
  return { seuil, delai, filet, coupures: (coupures / holds) * 100, attente: mediane(attentes), moyenne: attentes.reduce((a, b) => a + b, 0) / attentes.length, p90: quantile(attentes, 0.9), surFilet: (filets / attentes.length) * 100 };
}

/** Le front de Pareto : les réglages qu'aucun autre ne bat à la fois sur l'attente et sur les coupures. */
function pareto(points) {
  return points
    .filter((p) => !points.some((q) => q !== p && q.coupures <= p.coupures && q.attente <= p.attente && (q.coupures < p.coupures || q.attente < p.attente)))
    .sort((a, b) => a.coupures - b.coupures);
}

// ---------- 3. sortie ----------

const manifeste = JSON.parse(fs.readFileSync(path.join(CORPUS, "manifeste.json"), "utf8"));
console.log(`Corpus : ${manifeste.source}, ${manifeste.tours} tours français réels, ${manifeste.eot} fins de tour, ${manifeste.hold} hésitations.\n`);

const reference = referencePont(manifeste.liste);
console.log("== LE PONT D'AUJOURD'HUI (détecteur d'énergie, aucun modèle), rejoué sur ces mêmes tours ==");
console.log("filet ms | coupures % | attente médiane ms | attente moyenne ms | p90 ms");
for (const l of reference) {
  console.log(`${String(l.filet).padStart(8)} | ${l.coupures.toFixed(1).padStart(10)} | ${String(Math.round(l.attente)).padStart(18)} | ${String(Math.round(l.moyenne)).padStart(18)} | ${String(Math.round(l.p90)).padStart(6)}`);
}

for (const bande of BANDES) {
  const fichiers = fs.readdirSync(SORTIES).filter((f) => f.startsWith(`eot-scores-${bande}-`) && f.endsWith(".json"));
  if (!fichiers.length) { console.log(`\n(aucun score pour la bande ${bande}, lancer banc-eot-scores.mjs)`); continue; }
  const tours = fichiers.flatMap((f) => JSON.parse(fs.readFileSync(path.join(SORTIES, f), "utf8")).tours);
  const delais = [...new Set(tours.flatMap((t) => t.spans.flatMap((s) => Object.keys(s.scores).map(Number))))].sort((a, b) => a - b);

  const grille = [];
  for (const seuil of SEUILS) for (const delai of delais) for (const filet of FILETS) {
    if (filet < delai) continue;
    grille.push(evaluer(tours, seuil, delai, filet));
  }

  console.log(`\n== SMART TURN v3, bande ${bande} (${tours.length} tours) ==`);
  console.log("Front de Pareto (les réglages qu'aucun autre ne bat sur les deux mesures) :");
  console.log("coupures % | attente médiane ms | p90 ms | seuil | délai ms | filet ms");
  for (const p of pareto(grille)) {
    console.log(`${p.coupures.toFixed(1).padStart(10)} | ${String(Math.round(p.attente)).padStart(18)} | ${String(Math.round(p.p90)).padStart(6)} | ${String(p.seuil).padStart(5)} | ${String(p.delai).padStart(8)} | ${String(p.filet).padStart(8)}`);
  }

  // Le seul tableau qui décide : à nombre de coupures ÉGAL, combien de temps gagne-t-on ?
  console.log("\nÀ taux de coupure égal, ce que le modèle fait gagner :");
  console.log("coupures max % | pont : filet -> médiane / moyenne ms | modèle : médiane / moyenne ms (sur filet %) seuil/délai/filet | gain médiane / moyenne");
  for (const budget of [2, 5, 10, 18, 27]) {
    const p = reference.filter((l) => l.coupures <= budget).sort((a, b) => a.moyenne - b.moyenne)[0];
    const m = grille.filter((g) => g.coupures <= budget).sort((a, b) => a.moyenne - b.moyenne)[0];
    if (!p || !m) continue;
    console.log(`${String(budget).padStart(14)} | ${String(p.filet).padStart(10)} -> ${String(Math.round(p.attente)).padStart(5)} / ${String(Math.round(p.moyenne)).padStart(5)} | ${String(Math.round(m.attente)).padStart(6)} / ${String(Math.round(m.moyenne)).padStart(5)} (${m.surFilet.toFixed(0)} %) ${m.seuil}/${m.delai}/${m.filet} | ${String(Math.round(p.attente - m.attente)).padStart(6)} / ${String(Math.round(p.moyenne - m.moyenne)).padStart(5)}`);
  }
}
