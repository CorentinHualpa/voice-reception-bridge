/**
 * BANC DU MELANGE D'AMBIANCE
 *   node test/bancs/banc-ambiance-melange.mjs
 *
 * Verifie ce qui casse silencieusement : la longueur des paquets, le niveau reellement pose,
 * l'avancement dans la boucle, le bouclage, et les replis quand la source est mauvaise.
 * Rien ici ne depend de la telephonie.
 */

import { creerAmbiance, listerAmbiances, AMBIANCES } from "../../lib/ambiance.js";
import { ulawDecodeSample, ulawEncodeSample } from "../../lib/audio.js";

let echecs = 0;
const ok = (nom, cond, detail = "") => {
  if (cond) console.log(`  ok   ${nom}`);
  else { console.log(`  ECHEC ${nom} ${detail}`); echecs++; }
};

/** Niveau efficace d'un buffer mu-law, en fraction de la pleine echelle. */
function niveau(ulaw) {
  let s = 0;
  for (let i = 0; i < ulaw.length; i++) { const v = ulawDecodeSample(ulaw[i]) / 32768; s += v * v; }
  return Math.sqrt(s / ulaw.length);
}

const silence = (n) => Buffer.alloc(n, 0xff); // mu-law 0xFF = zero

/** Une fausse voix a un niveau connu, pour mesurer ce que le fond ajoute dessous. */
function fausseVoix(n, amplitude = 0.3) {
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = ulawEncodeSample(Math.round(Math.sin(i * 0.11) * amplitude * 32767));
  return out;
}

console.log("\n== Le catalogue ==");
const liste = listerAmbiances();
ok("cinq ambiances", liste.length === 5, String(liste.length));
ok("quatre viennent d'enregistrements", liste.filter((a) => a.origine === "enregistrement").length === 4);
ok("le bruit de confort est synthétisé", liste.find((a) => a.id === "confort")?.origine === "synthèse");
for (const a of liste) console.log(`       ${a.id.padEnd(15)} ${a.origine}`);

console.log("\n== Chargement de chaque preset ==");
for (const id of Object.keys(AMBIANCES)) {
  const amb = creerAmbiance({ preset: id, gain: 0.06 });
  ok(`${id} chargé`, !!amb && amb.secondes > 1, amb ? `${amb.secondes.toFixed(1)} s` : "null");
}

console.log("\n== Longueurs préservées ==");
const amb = creerAmbiance({ preset: "centre-appels", gain: 0.06, ratioVoix: 0.55 });
for (const n of [160, 320, 800, 1234]) {
  ok(`mélange de ${n} octets`, amb.melanger(silence(n)).length === n);
  ok(`paquet de ${n} octets`, amb.paquet(n).length === n);
}

console.log("\n== Les deux niveaux ==");
const a1 = creerAmbiance({ preset: "centre-appels", gain: 0.06, ratioVoix: 0.55 });
const nBlanc = niveau(a1.melanger(silence(8000), { sousVoix: false }));
const a2 = creerAmbiance({ preset: "centre-appels", gain: 0.06, ratioVoix: 0.55 });
const nSousVoix = niveau(a2.melanger(silence(8000), { sousVoix: true }));
console.log(`       blanc ${nBlanc.toFixed(5)} · sous la voix ${nSousVoix.toFixed(5)} · rapport ${(nSousVoix / nBlanc).toFixed(2)}`);
ok("le fond est plus bas sous la voix", nSousVoix < nBlanc * 0.8, `${(nSousVoix / nBlanc).toFixed(2)}`);
ok("le fond reste audible dans un blanc", nBlanc > 0.002, nBlanc.toFixed(5));
ok("le fond reste sous le seuil de détection de voix", nBlanc < 0.05, nBlanc.toFixed(5));

console.log("\n== Le fond ne couvre pas la voix ==");
const a3 = creerAmbiance({ preset: "centre-appels", gain: 0.06, ratioVoix: 0.55 });
const voix = fausseVoix(8000, 0.3);
const melange = a3.melanger(voix, { sousVoix: true });
const nVoix = niveau(voix), nMelange = niveau(melange);
const ajout = 20 * Math.log10(nMelange / nVoix);
console.log(`       voix seule ${nVoix.toFixed(4)} · avec le fond ${nMelange.toFixed(4)} · ${ajout >= 0 ? "+" : ""}${ajout.toFixed(2)} dB`);
ok("le mélange n'ajoute pas plus de 1 dB sur la voix", Math.abs(ajout) < 1, `${ajout.toFixed(2)} dB`);

console.log("\n== Avancement et bouclage ==");
const a4 = creerAmbiance({ preset: "bureau", gain: 0.06 });
const p1 = a4.paquet(800), p2 = a4.paquet(800);
ok("deux paquets successifs diffèrent", !p1.equals(p2));
// On consomme toute la boucle et un peu plus : elle doit revenir a son debut sans erreur ni trou.
const total = Math.ceil(a4.secondes * 8000) + 1600;
let reste = total, erreur = null;
try { while (reste > 0) { const n = Math.min(800, reste); a4.paquet(n); reste -= n; } } catch (e) { erreur = e; }
ok("la boucle repasse au début sans erreur", !erreur, String(erreur));
ok("le temps joué est compté", a4.msJoues > (total / 8000) * 1000 * 0.9);

console.log("\n== Les replis ==");
ok("gain nul coupe l'ambiance", creerAmbiance({ preset: "bureau", gain: 0 }) === null);
ok("gain négatif coupe l'ambiance", creerAmbiance({ preset: "bureau", gain: -1 }) === null);
const inconnu = creerAmbiance({ preset: "nexistepas", gain: 0.06 });
ok("un preset inconnu retombe sur le bruit de confort", inconnu?.libelle === AMBIANCES.confort.libelle, inconnu?.libelle);
const mauvaisWav = creerAmbiance({ wavBuffer: Buffer.from("ceci n'est pas un wav"), gain: 0.06 });
ok("un WAV illisible retombe sur un preset", !!mauvaisWav && mauvaisWav.libelle !== "fichier du client", mauvaisWav?.libelle);

console.log("\n== Un WAV fourni par un client ==");
// Un WAV minimal valide : 2 s de sinus a 8 kHz.
const n = 16000;
const corps = Buffer.alloc(n * 2);
for (let i = 0; i < n; i++) corps.writeInt16LE(Math.round(Math.sin(i * 0.05) * 20000), i * 2);
const e = Buffer.alloc(44);
e.write("RIFF", 0); e.writeUInt32LE(36 + corps.length, 4); e.write("WAVE", 8);
e.write("fmt ", 12); e.writeUInt32LE(16, 16); e.writeUInt16LE(1, 20); e.writeUInt16LE(1, 22);
e.writeUInt32LE(8000, 24); e.writeUInt32LE(16000, 28); e.writeUInt16LE(2, 32); e.writeUInt16LE(16, 34);
e.write("data", 36); e.writeUInt32LE(corps.length, 40);
const perso = creerAmbiance({ wavBuffer: Buffer.concat([e, corps]), gain: 0.06 });
ok("le WAV du client est accepté", perso?.libelle === "fichier du client", perso?.libelle);
ok("et il prime sur le preset", perso?.secondes > 1 && perso.secondes < 2.5, perso?.secondes?.toFixed(2));

console.log(echecs === 0 ? "\n*** TOUT PASSE ***\n" : `\n*** ${echecs} ECHEC(S) ***\n`);
process.exit(echecs === 0 ? 0 : 1);
