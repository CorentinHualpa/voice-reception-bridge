/**
 * PREPARER UNE AMBIANCE : d'un enregistrement quelconque vers une boucle jouable par le pont.
 *
 *   node scripts/preparer-ambiance.mjs <id> <source> [options]
 *
 *   <source>  une URL ou un chemin local (mp3, ogg, wav, m4a, flac…)
 *   --debut   secondes a sauter au debut (defaut 0)
 *   --duree   longueur de la boucle en secondes (defaut 60)
 *   --fondu   raccord de boucle en ms (defaut 700)
 *   --gain    correction manuelle avant normalisation (defaut 1)
 *
 * Produit assets/ambiances/<id>.wav : mono, 8 kHz, PCM 16 bits, normalise et deja
 * raccorde en boucle, donc lisible tel quel par lib/ambiance.js.
 *
 * Le raccord de boucle est fait ICI, une fois pour toutes, plutot qu'au chargement : un fondu
 * de 700 ms sur une vraie ambiance ne s'entend pas, alors qu'une coupure nette claque a chaque
 * tour de boucle et se remarque immediatement sur un appel un peu long.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const RACINE = path.join(ICI, "..");
const DOSSIER = path.join(RACINE, "assets", "ambiances");
const TAUX = 8000;

const [, , id, source, ...reste] = process.argv;
if (!id || !source) {
  console.error("usage : node scripts/preparer-ambiance.mjs <id> <url-ou-fichier> [--debut S] [--duree S] [--fondu MS] [--gain N]");
  process.exit(1);
}
const opt = (nom, defaut) => {
  const i = reste.indexOf(`--${nom}`);
  return i >= 0 && reste[i + 1] !== undefined ? Number(reste[i + 1]) : defaut;
};
const DEBUT = opt("debut", 0);
const DUREE = opt("duree", 60);
const FONDU_MS = opt("fondu", 700);
const GAIN = opt("gain", 1);

fs.mkdirSync(DOSSIER, { recursive: true });
const tmp = path.join(RACINE, `.tmp-ambiance-${id}.wav`);

/* 1. Decodage vers 8 kHz mono PCM 16 bits, par ffmpeg. ffmpeg lit les URL directement. */
console.log(`Décodage de ${source}…`);
execFileSync("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  "-ss", String(DEBUT),
  "-i", source,
  "-t", String(DUREE),
  "-ac", "1",
  "-ar", String(TAUX),
  "-af", `volume=${GAIN}`,
  "-c:a", "pcm_s16le",
  tmp,
], { stdio: ["ignore", "inherit", "inherit"] });

/* 2. Lecture du PCM. */
const brut = fs.readFileSync(tmp);
let debutData = 44;
// On retrouve le bloc data plutot que de supposer un entete de 44 octets.
for (let p = 12; p + 8 <= brut.length; ) {
  const bloc = brut.toString("ascii", p, p + 4);
  const taille = brut.readUInt32LE(p + 4);
  if (bloc === "data") { debutData = p + 8; break; }
  p += 8 + taille + (taille % 2);
}
const pcmSrc = brut.subarray(debutData);
const n = Math.floor(pcmSrc.length / 2);
if (n < TAUX * 5) { console.error(`Trop court : ${(n / TAUX).toFixed(1)} s. Il en faut au moins 5.`); process.exit(1); }

const x = new Float32Array(n);
for (let i = 0; i < n; i++) x[i] = pcmSrc.readInt16LE(i * 2) / 32768;

/* 3. Retrait du continu : beaucoup d'enregistrements de terrain ont un offset qui mange de la marge. */
let moyenne = 0;
for (let i = 0; i < n; i++) moyenne += x[i];
moyenne /= n;
for (let i = 0; i < n; i++) x[i] -= moyenne;

/* 4. Raccord de boucle en fondu croise : la fin se fond dans le debut. */
const fondu = Math.min(Math.floor(n / 3), Math.floor((FONDU_MS / 1000) * TAUX));
const utile = n - fondu;
const out = new Float32Array(utile);
for (let i = 0; i < utile; i++) {
  if (i < fondu) {
    const f = i / fondu;
    out[i] = x[i] * f + x[utile + i] * (1 - f);
  } else out[i] = x[i];
}

/* 5. Normalisation en crete a 0,95, le gain reel etant applique a la lecture par le pont. */
let crete = 1e-6;
for (let i = 0; i < utile; i++) crete = Math.max(crete, Math.abs(out[i]));
const k = 0.95 / crete;

/* 6. Ecriture du WAV. */
const corps = Buffer.alloc(utile * 2);
for (let i = 0; i < utile; i++) {
  corps.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out[i] * k * 32767))), i * 2);
}
const e = Buffer.alloc(44);
e.write("RIFF", 0); e.writeUInt32LE(36 + corps.length, 4); e.write("WAVE", 8);
e.write("fmt ", 12); e.writeUInt32LE(16, 16); e.writeUInt16LE(1, 20); e.writeUInt16LE(1, 22);
e.writeUInt32LE(TAUX, 24); e.writeUInt32LE(TAUX * 2, 28); e.writeUInt16LE(2, 32); e.writeUInt16LE(16, 34);
e.write("data", 36); e.writeUInt32LE(corps.length, 40);

const cible = path.join(DOSSIER, `${id}.wav`);
fs.writeFileSync(cible, Buffer.concat([e, corps]));
fs.unlinkSync(tmp);

/* 7. Mesure : une ambiance utile doit avoir du RELIEF, pas un niveau plat.
      On compare l'energie des tranches de 200 ms : un enregistrement vivant a un ecart net
      entre ses moments calmes et ses evenements ; un lit de bruit stationnaire n'en a aucun. */
const tranche = Math.floor(0.2 * TAUX);
const energies = [];
for (let p = 0; p + tranche <= utile; p += tranche) {
  let s = 0;
  for (let i = p; i < p + tranche; i++) s += out[i] * out[i];
  energies.push(Math.sqrt(s / tranche));
}
const tri = [...energies].sort((a, b) => a - b);
const p10 = tri[Math.floor(tri.length * 0.1)] || 1e-9;
const p90 = tri[Math.floor(tri.length * 0.9)] || 1e-9;
const relief = 20 * Math.log10(p90 / p10);

console.log(`\n✓ ${cible}`);
console.log(`  durée ${(utile / TAUX).toFixed(1)} s · raccord ${FONDU_MS} ms · ${(corps.length / 1024).toFixed(0)} ko`);
console.log(`  relief ${relief.toFixed(1)} dB entre les moments calmes et les moments forts`);
if (relief < 6) console.log(`  ⚠ moins de 6 dB : c'est un lit de bruit plat, il s'entendra comme un défaut de ligne et non comme un lieu.`);
else if (relief > 24) console.log(`  ⚠ plus de 24 dB : trop d'écart, un événement fort passera devant la voix. Chercher un extrait plus régulier.`);
else console.log(`  relief correct.`);
