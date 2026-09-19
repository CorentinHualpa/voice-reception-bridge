/**
 * CHERCHER LE MEILLEUR EXTRAIT d'un enregistrement d'ambiance.
 *
 *   node scripts/chercher-extrait.mjs <fichier> [--duree S] [--pas S]
 *
 * Decode l'enregistrement UNE fois en 8 kHz mono, puis mesure, pour chaque fenetre possible,
 * le RELIEF : l'ecart en dB entre les tranches de 200 ms calmes (10e centile) et fortes (90e).
 *
 * Pourquoi ce critere. Un fond sonore qui n'a pas de relief s'entend comme un defaut de ligne
 * et non comme un lieu (constate le 19/09/2026 : des lits de bruit synthetises, donc a relief
 * nul, ont tous ete rejetes a l'ecoute). Ce qui fait « il y a du monde derriere », ce sont les
 * EVENEMENTS : une voix qui emerge, un tiroir, une porte. Choisir une fenetre au hasard dans un
 * enregistrement de vingt minutes tombe le plus souvent sur un passage stationnaire.
 *
 * On ecarte aussi les fenetres trop contrastees : un evenement isole tres fort passerait devant
 * la voix de l'agent.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const TAUX = 8000;

const [, , source, ...reste] = process.argv;
if (!source) {
  console.error("usage : node scripts/chercher-extrait.mjs <fichier> [--duree S] [--pas S]");
  process.exit(1);
}
const opt = (n, d) => { const i = reste.indexOf(`--${n}`); return i >= 0 ? Number(reste[i + 1]) : d; };
const DUREE = opt("duree", 90);
const PAS = opt("pas", 15);

const tmp = path.join(path.dirname(ICI), `.tmp-scan.raw`);
console.log("Décodage complet…");
execFileSync("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  "-i", source, "-ac", "1", "-ar", String(TAUX), "-f", "s16le", tmp,
], { stdio: ["ignore", "inherit", "inherit"] });

const brut = fs.readFileSync(tmp);
fs.unlinkSync(tmp);
const n = Math.floor(brut.length / 2);
console.log(`${(n / TAUX / 60).toFixed(1)} min décodées.\n`);

// Energie par tranche de 200 ms, calculee une seule fois.
const tranche = Math.floor(0.2 * TAUX);
const nbTranches = Math.floor(n / tranche);
const energie = new Float64Array(nbTranches);
for (let t = 0; t < nbTranches; t++) {
  let s = 0;
  for (let i = t * tranche; i < (t + 1) * tranche; i++) { const v = brut.readInt16LE(i * 2) / 32768; s += v * v; }
  energie[t] = Math.sqrt(s / tranche);
}

const trPar = Math.floor((DUREE * TAUX) / tranche);
const pasTr = Math.max(1, Math.floor((PAS * TAUX) / tranche));
const resultats = [];

for (let debut = 0; debut + trPar <= nbTranches; debut += pasTr) {
  const bloc = Array.from(energie.subarray(debut, debut + trPar)).sort((a, b) => a - b);
  const p10 = bloc[Math.floor(bloc.length * 0.1)] || 1e-9;
  const p50 = bloc[Math.floor(bloc.length * 0.5)] || 1e-9;
  const p90 = bloc[Math.floor(bloc.length * 0.9)] || 1e-9;
  const p99 = bloc[Math.floor(bloc.length * 0.99)] || 1e-9;
  resultats.push({
    secondes: Math.round((debut * tranche) / TAUX),
    relief: 20 * Math.log10(p90 / p10),
    pointe: 20 * Math.log10(p99 / p50), // un evenement isole trop fort passerait devant la voix
    niveau: p50,
  });
}

// On veut du relief, mais pas de pointe qui domine : on ecarte au-dela de 18 dB de pointe.
const bons = resultats.filter((r) => r.pointe < 18);
bons.sort((a, b) => b.relief - a.relief);

console.log("Les dix meilleures fenêtres :\n");
console.log("  début    relief   pointe   niveau");
for (const r of bons.slice(0, 10)) {
  console.log(
    `  ${String(r.secondes).padStart(5)} s  ${r.relief.toFixed(1).padStart(6)} dB  ${r.pointe.toFixed(1).padStart(6)} dB  ${r.niveau.toFixed(4)}`
  );
}
if (!bons.length) console.log("  aucune fenêtre exploitable (toutes dominées par une pointe)");

const rejets = resultats.length - bons.length;
console.log(`\n${resultats.length} fenêtres examinées, ${rejets} écartées pour pointe trop forte.`);
if (bons[0]) {
  console.log(`\nÀ reprendre :\n  node scripts/preparer-ambiance.mjs <id> "${source}" --debut ${bons[0].secondes} --duree ${DUREE}`);
}
