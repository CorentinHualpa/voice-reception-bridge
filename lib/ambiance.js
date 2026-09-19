// AMBIANCE DE SALLE : un fond sonore tres bas, CONTINU, derriere toute la duree de l'appel.
//
// Pourquoi c'est necessaire. Le G.711 de Twilio transmet le silence tel quel, en zeros. Une vraie ligne
// telephonique n'a jamais de silence absolu : les codecs generent du bruit de confort (RFC 3389) precisement
// pour ca. Sans rien derriere, chaque blanc s'entend comme une ligne coupee, et c'est ce qui fait « robot »
// bien plus que la latence.
//
// Pourquoi CONTINU et non pendant les seuls blancs (correction du 19/09/2026). La premiere version ne jouait
// le fond qu'apres AMBIANCE_APRES_MS de blanc. C'est l'erreur : l'oreille detecte un DEBUT et une FIN de son
// bien mieux qu'un niveau constant, donc un fond qui s'allume quand il y a un blanc ne masque pas le blanc,
// il l'ANNONCE. C'est ce que fait Vapi avec son `backgroundSound` : une boucle jouee du debut a la fin, sans
// aucun declencheur (verifie le 19/09/2026 sur leur API : les seules valeurs admises sont off, office, ou une
// URL, il n'y a ni gain ni condition).
//
// Pourquoi de VRAIS ENREGISTREMENTS et non de la synthese (essai du 19/09/2026). Cinq lits de bruit
// synthetises ont tous ete rejetes a l'ecoute : « comme si ça captait mal ». La raison tient en un chiffre,
// leur RELIEF, l'ecart entre les tranches de 200 ms calmes et fortes : nul chez eux, 7,5 dB pour un vrai
// bureau, 8,0 pour un centre d'appels. Ce qui fait « il y a du monde derriere », ce sont les EVENEMENTS,
// une voix qui emerge, une porte, une imprimante. Un bruit stationnaire n'en a aucun, quelle que soit la
// finesse de son spectre. Voir scripts/preparer-ambiance.mjs, qui mesure ce relief et refuse les lits plats.
//
// Deux niveaux, pas un. Le fond est pose plus bas PENDANT que l'agent parle (ratioVoix) que dans les blancs :
// au meme niveau, il encombre l'intelligibilite de la voix sans rien apporter.
//
// Le gain est volontairement tres bas (0,06 en crete, ~ -24 dB) : assez pour tenir la ligne, trop bas pour
// passer le seuil de detection de voix du pont, meme reinjecte par un haut-parleur.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ulawEncodeSample, ulawDecodeSample } from "./audio.js";

const TAUX = 8000;
const DUREE_S = 12;    // longueur de la boucle quand elle est synthetisee
const FONDU_MS = 400;  // raccord entre la fin et le debut, pour que la boucle ne claque pas

const DOSSIER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "ambiances");

/* ------------------------------------------------------------------ */
/* Synthese, pour le seul bruit de confort                              */
/* ------------------------------------------------------------------ */

const alea = () => Math.random() * 2 - 1;

/** Bruit blanc passe-bas a un pole. `k` proche de 1 = plus sourd. */
function souffle(n, k) {
  const out = new Float32Array(n);
  let etat = 0;
  for (let i = 0; i < n; i++) {
    etat = etat * k + alea() * (1 - k);
    out[i] = etat;
  }
  return out;
}

/** Retire le continu et les tres basses : un passe-haut a un pole. */
function passeHaut(x, k) {
  const out = new Float32Array(x.length);
  let prevEntree = 0, prevSortie = 0;
  for (let i = 0; i < x.length; i++) {
    prevSortie = k * (prevSortie + x[i] - prevEntree);
    prevEntree = x[i];
    out[i] = prevSortie;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Le catalogue                                                         */
/* ------------------------------------------------------------------ */

// Les ambiances de lieu sont des enregistrements reels, tous en CC0, donc redistribuables dans un
// produit vendu et sans obligation d'attribution. Provenance : assets/ambiances/LICENCES.md.
//
// « confort » reste synthetise, et c'est legitime : ce n'est pas un decor mais du bruit de confort au
// sens du codec (RFC 3389), un souffle neutre dont le role est justement de n'evoquer aucun lieu.

export const AMBIANCES = {
  confort: {
    libelle: "Bruit de confort",
    description: "Le souffle neutre d'une ligne ouverte. Aucun lieu, aucun décor. Le repli sûr, celui qui ne peut jamais détonner.",
    construire: (n) => passeHaut(souffle(n, 0.93), 0.9),
  },
  "centre-appels": {
    libelle: "Centre d'appels",
    description: "Des voix autour, une imprimante, un clavier, une porte. L'équivalent du « office » de Vapi, et le plus crédible derrière un appel sortant professionnel.",
    fichier: "centre-appels.wav",
  },
  bureau: {
    libelle: "Bureau",
    description: "Une pièce où quelqu'un travaille, plus calme que le centre d'appels : ventilation et quelques gestes.",
    fichier: "bureau.wav",
  },
  salle: {
    libelle: "Salle de restaurant",
    description: "Une salle pleine entendue depuis le comptoir, conversations et couverts.",
    fichier: "salle.wav",
  },
  rue: {
    libelle: "Rue",
    description: "Une circulation urbaine lointaine. Stationnaire par nature, donc moins de relief que les autres : à réserver à un agent qu'on imagine en déplacement.",
    fichier: "rue.wav",
  },
};

export const listerAmbiances = () =>
  Object.entries(AMBIANCES).map(([id, a]) => ({
    id,
    libelle: a.libelle,
    description: a.description,
    origine: a.fichier ? "enregistrement" : "synthèse",
  }));

/* ------------------------------------------------------------------ */
/* Lecture d'un WAV                                                     */
/* ------------------------------------------------------------------ */

/** WAV PCM 16 bits : renvoie { pcm, rate, canaux } ou null si l'entete n'est pas lisible. */
function lireWav(buf) {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let pos = 12, rate = TAUX, canaux = 1, bits = 16, data = null;
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

/** Reechantillonnage lineaire vers 8 kHz mono, suffisant pour un fond de salle. */
function vers8kMono({ pcm, rate, canaux }) {
  const echantillons = Math.floor(pcm.length / 2 / canaux);
  const sortieN = Math.max(1, Math.floor((echantillons * TAUX) / rate));
  const out = new Float32Array(sortieN);
  for (let i = 0; i < sortieN; i++) {
    const src = (i * rate) / TAUX;
    const a = Math.floor(src), b = Math.min(echantillons - 1, a + 1), f = src - a;
    let va = 0, vb = 0;
    for (let c = 0; c < canaux; c++) { va += pcm.readInt16LE((a * canaux + c) * 2); vb += pcm.readInt16LE((b * canaux + c) * 2); }
    out[i] = ((va / canaux) * (1 - f) + (vb / canaux) * f) / 32768;
  }
  return out;
}

/** Telecharge un WAV fourni par le client. Borne en taille : un fond de salle ne pese pas 50 Mo. */
export async function telechargerWav(url, { maxOctets = 12 * 1024 * 1024, timeoutMs = 8000 } = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxOctets) throw new Error(`${(buf.length / 1e6).toFixed(1)} Mo, au-delà de la limite`);
  return buf;
}

/** Le PCM 8 kHz d'un preset, depuis son fichier ou depuis la synthese. */
function pcmDuPreset(cle) {
  const a = AMBIANCES[cle];
  if (a.construire) return a.construire(DUREE_S * TAUX);
  const wav = lireWav(fs.readFileSync(path.join(DOSSIER, a.fichier)));
  if (!wav) throw new Error(`assets/ambiances/${a.fichier} n'est pas un WAV PCM 16 bits`);
  return vers8kMono(wav);
}

/* ------------------------------------------------------------------ */
/* Fabrication de la boucle                                             */
/* ------------------------------------------------------------------ */

/**
 * Normalise a `gain` fois la pleine echelle en crete, puis raccorde la boucle en fondu croise.
 * Les fichiers du catalogue sont deja raccordes par scripts/preparer-ambiance.mjs ; le fondu
 * refait ici ne coute rien et protege les fichiers fournis par un client, qui ne le sont pas.
 */
function boucler(x, gain) {
  const n = x.length;
  let crete = 1e-6;
  for (let i = 0; i < n; i++) crete = Math.max(crete, Math.abs(x[i]));
  const k = gain / crete;
  const fondu = Math.min(Math.floor(n / 4), Math.floor((FONDU_MS / 1000) * TAUX));
  const utile = n - fondu;
  const out = new Int16Array(utile);
  for (let i = 0; i < utile; i++) {
    let v = x[i];
    if (i < fondu) {
      const f = i / fondu;
      v = x[i] * f + x[utile + i] * (1 - f);
    }
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * k * 32767)));
  }
  return out;
}

const cache = new Map();

/**
 * Construit une ambiance jouable.
 *
 *   preset     : une cle de AMBIANCES (defaut « confort »)
 *   wavBuffer  : un WAV PCM 16 bits fourni par le client, qui prime sur le preset
 *   gain       : niveau en crete dans les blancs (0,06 par defaut)
 *   ratioVoix  : facteur applique PENDANT que l'agent parle (0,55 par defaut)
 *
 * Renvoie null si l'ambiance est coupee (gain nul ou negatif).
 */
export function creerAmbiance({ preset = "confort", wavBuffer = null, gain = 0.06, ratioVoix = 0.55 } = {}) {
  if (!(gain > 0)) return null;

  let boucle = null, libelle = "";

  if (wavBuffer) {
    const wav = lireWav(wavBuffer);
    if (wav) { boucle = boucler(vers8kMono(wav), gain); libelle = "fichier du client"; }
    else console.error("[ambiance] le fichier fourni n'est pas un WAV PCM 16 bits, repli sur un preset");
  }

  if (!boucle) {
    const cle = AMBIANCES[preset] ? preset : "confort";
    if (!AMBIANCES[preset]) console.error(`[ambiance] preset « ${preset} » inconnu, repli sur « confort »`);
    const enCache = cache.get(`${cle}|${gain}`);
    if (enCache) boucle = enCache;
    else {
      try {
        boucle = boucler(pcmDuPreset(cle), gain);
      } catch (err) {
        console.error(`[ambiance] ${cle} illisible (${err.message}), repli sur le bruit de confort`);
        boucle = boucler(AMBIANCES.confort.construire(DUREE_S * TAUX), gain);
      }
      cache.set(`${cle}|${gain}`, boucle);
    }
    libelle = AMBIANCES[cle].libelle;
  }

  let pos = 0;
  let msJoues = 0;

  /** Avance dans la boucle et rend `n` echantillons PCM, en bouclant proprement. */
  function echantillons(n) {
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = boucle[pos];
      if (++pos >= boucle.length) pos = 0;
    }
    msJoues += (n / TAUX) * 1000;
    return out;
  }

  return {
    libelle,
    secondes: boucle.length / TAUX,
    get msJoues() { return msJoues; },

    /** Un paquet d'ambiance seule, en mu-law, pour les moments ou rien d'autre ne part. */
    paquet(nOctets) {
      const pcm = echantillons(nOctets);
      const out = Buffer.alloc(nOctets);
      for (let i = 0; i < nOctets; i++) out[i] = ulawEncodeSample(pcm[i]);
      return out;
    },

    /**
     * Pose l'ambiance SOUS un audio mu-law existant (la voix de l'agent, ou sa queue de silence).
     * C'est ce qui rend le fond continu : l'audio de l'agent part dans la file de Twilio sans etre
     * cadence en temps reel, donc un fond joue « a cote » arriverait decale.
     */
    melanger(ulaw, { sousVoix = true } = {}) {
      const n = ulaw.length;
      const fond = echantillons(n);
      const k = sousVoix ? ratioVoix : 1;
      const out = Buffer.alloc(n);
      for (let i = 0; i < n; i++) {
        const somme = ulawDecodeSample(ulaw[i]) + fond[i] * k;
        out[i] = ulawEncodeSample(Math.max(-32768, Math.min(32767, Math.round(somme))));
      }
      return out;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Rendu WAV, pour ecouter les presets hors appel                       */
/* ------------------------------------------------------------------ */

/** Rend un preset en WAV PCM 16 bits 8 kHz, au gain d'ecoute demande (0,3 pour l'entendre vraiment). */
export function rendreWav(preset, { secondes = 10, gain = 0.3 } = {}) {
  if (!AMBIANCES[preset]) throw new Error(`preset inconnu : ${preset}`);
  let pcm = boucler(pcmDuPreset(preset), gain);
  const voulu = Math.round(secondes * TAUX);
  // On rejoue la boucle autant de fois qu'il faut pour atteindre la duree demandee.
  const corps = Buffer.alloc(voulu * 2);
  for (let i = 0; i < voulu; i++) corps.writeInt16LE(pcm[i % pcm.length], i * 2);

  const e = Buffer.alloc(44);
  e.write("RIFF", 0); e.writeUInt32LE(36 + corps.length, 4); e.write("WAVE", 8);
  e.write("fmt ", 12); e.writeUInt32LE(16, 16); e.writeUInt16LE(1, 20); e.writeUInt16LE(1, 22);
  e.writeUInt32LE(TAUX, 24); e.writeUInt32LE(TAUX * 2, 28); e.writeUInt16LE(2, 32); e.writeUInt16LE(16, 34);
  e.write("data", 36); e.writeUInt32LE(corps.length, 40);
  return Buffer.concat([e, corps]);
}

/** Compatibilite avec l'ancienne signature (fond joue pendant les seuls blancs). */
export function chargerAmbiance({ source = "", gain = 0.06 } = {}) {
  let wavBuffer = null;
  if (source && source !== "confort" && !AMBIANCES[source]) {
    try { wavBuffer = fs.readFileSync(source); }
    catch (err) { console.error(`[ambiance] ${source} illisible (${err.message}), repli sur un preset`); }
  }
  return creerAmbiance({ preset: AMBIANCES[source] ? source : "confort", wavBuffer, gain });
}
