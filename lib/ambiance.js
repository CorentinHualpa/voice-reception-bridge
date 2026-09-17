// AMBIANCE DE SALLE : de quoi remplir les blancs de Grok sans faire parler l'agent.
//
// Le « Mmm » d'attente a ete rejete a l'ecoute le 17/09/2026 (« pas du tout naturel ») : un son de synthese
// isole, rejoue a l'identique, s'entend comme un tic. Ce qui gene vraiment dans un pic de Grok (2,7 a 3,7 s)
// n'est pas l'absence de mot, c'est le SILENCE NUMERIQUE TOTAL, qui s'entend comme une ligne coupee. Un fond
// de salle tres bas, continu, enleve cette impression sans rien pretendre : personne ne l'entend comme une
// replique, donc rien ne peut sonner faux. C'est le principe du bruit de confort des codecs telephoniques
// (RFC 3389), que le G.711 de Twilio ne genere pas puisqu'il transmet le silence tel quel.
//
// Deux sources :
//   - un fichier WAV PCM 16 bits mono (n'importe quel taux, reechantillonne au plus simple) : un vrai
//     brouhaha de salle, qui donne « il y a du monde derriere » ;
//   - a defaut, un bruit de confort synthetise : bruit blanc passe-bas, plus doux qu'un souffle brut.
//
// Le resultat est une boucle mu-law 8 kHz prete a envoyer a Twilio paquet par paquet, avec un raccord en
// fondu pour que la boucle ne claque pas. Le GAIN est volontairement tres bas (0,06 par defaut, ~ -24 dB) :
// assez pour tenir la ligne, trop bas pour passer le seuil de detection de voix du pont, meme reinjecte par
// un haut-parleur.
import fs from "node:fs";
import { pcm16ToUlaw8k } from "./audio.js";

const DUREE_S = 8;          // longueur de la boucle quand elle est synthetisee
const FONDU_MS = 250;       // raccord entre la fin et le debut de la boucle

// WAV PCM 16 bits : renvoie { pcm, rate, canaux } ou null si l'entete n'est pas lisible.
function lireWav(buf) {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let pos = 12, rate = 8000, canaux = 1, bits = 16, data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const taille = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") { canaux = buf.readUInt16LE(pos + 10); rate = buf.readUInt32LE(pos + 12); bits = buf.readUInt16LE(pos + 22); }
    else if (id === "data") { data = buf.subarray(pos + 8, Math.min(buf.length, pos + 8 + taille)); break; }
    pos += 8 + taille + (taille % 2);
  }
  if (!data || bits !== 16) return null;
  return { pcm: data, rate, canaux };
}

// Reechantillonnage lineaire vers 8 kHz mono, suffisant pour un fond de salle.
function vers8kMono({ pcm, rate, canaux }) {
  const echantillons = Math.floor(pcm.length / 2 / canaux);
  const sortieN = Math.floor((echantillons * 8000) / rate);
  const out = Buffer.alloc(sortieN * 2);
  for (let i = 0; i < sortieN; i++) {
    const src = (i * rate) / 8000;
    const a = Math.floor(src), b = Math.min(echantillons - 1, a + 1), f = src - a;
    let va = 0, vb = 0;
    for (let c = 0; c < canaux; c++) { va += pcm.readInt16LE((a * canaux + c) * 2); vb += pcm.readInt16LE((b * canaux + c) * 2); }
    out.writeInt16LE(Math.round((va / canaux) * (1 - f) + (vb / canaux) * f), i * 2);
  }
  return out;
}

// Bruit blanc passe-bas a un pole : un souffle de salle, sans la durete du bruit blanc pur.
function bruitDeConfort(nEchantillons) {
  const out = Buffer.alloc(nEchantillons * 2);
  let etat = 0;
  for (let i = 0; i < nEchantillons; i++) {
    etat = etat * 0.93 + (Math.random() * 2 - 1) * 0.07;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(etat * 32767))), i * 2);
  }
  return out;
}

// Normalise le PCM a `gain` fois la pleine echelle (en crete), puis raccorde la boucle en fondu croise.
function preparer(pcm, gain) {
  const n = pcm.length / 2;
  let crete = 1;
  for (let i = 0; i < n; i++) crete = Math.max(crete, Math.abs(pcm.readInt16LE(i * 2)));
  const k = (gain * 32767) / crete;
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i * 2) * k))), i * 2);
  const fondu = Math.min(Math.floor(n / 4), Math.floor((FONDU_MS / 1000) * 8000));
  for (let i = 0; i < fondu; i++) {
    const f = i / fondu;
    const debut = out.readInt16LE(i * 2), fin = out.readInt16LE((n - fondu + i) * 2);
    out.writeInt16LE(Math.round(debut * f + fin * (1 - f)), i * 2);
  }
  return out.subarray(0, (n - fondu) * 2);
}

// Renvoie la boucle mu-law 8 kHz, ou null si l'ambiance est coupee.
// `source` : chemin d'un WAV, ou "" / "confort" pour le bruit synthetise.
export function chargerAmbiance({ source = "", gain = 0.06 } = {}) {
  if (gain <= 0) return null;
  let pcm = null;
  if (source && source !== "confort") {
    try {
      const wav = lireWav(fs.readFileSync(source));
      if (wav) pcm = vers8kMono(wav);
      else console.error(`[ambiance] ${source} n'est pas un WAV PCM 16 bits, repli sur le bruit de confort`);
    } catch (err) {
      console.error(`[ambiance] ${source} illisible (${err.message}), repli sur le bruit de confort`);
    }
  }
  if (!pcm) pcm = bruitDeConfort(DUREE_S * 8000);
  const boucle = pcm16ToUlaw8k(preparer(pcm, gain), 8000);
  console.log(`[ambiance] boucle de ${(boucle.length / 8000).toFixed(1)} s prete (${source && source !== "confort" ? source : "bruit de confort"}, gain ${gain})`);
  return boucle;
}
