// Passe Smart Turn v3 sur le corpus français réel de LiveKit, et écrit une probabilité par point de
// décision. C'est la partie lente du chantier : elle se shardé sur plusieurs processus et son résultat se
// rejoue à volonté par `banc-eot-politique.mjs`, qui balaye les réglages sans refaire une seule inférence.
//
// Protocole, repris du benchmark ouvert de LiveKit pour que nos chiffres se comparent aux siens : chaque
// tour de parole est rejoué CAUSALEMENT. À chaque silence du tour, on demande au modèle, avec l'audio qu'il
// aurait réellement eu à cet instant et rien de plus, si le client a fini. Le dernier silence est une vraie
// fin de tour, tous les autres sont des hésitations. On interroge à plusieurs délais après le début du
// silence, parce que le délai d'action est justement un des réglages à arbitrer : attendre plus longtemps
// coupe moins, mais fait patienter sur CHAQUE tour.
//
// Un silence d'hésitation n'est interrogé qu'aux délais qui tiennent dedans : passé sa durée, le client a
// repris la parole, le système n'a plus rien à décider.
//
// Deux bandes, parce que c'est LA question ouverte du chantier :
//   large       le 16 kHz du corpus, ce que le modèle a vu à l'entraînement
//   telephone   le même descendu à 8 kHz, quantifié en mu-law et remonté, ce que notre pont lui donnerait
//
// Usage : node test/bancs/banc-eot-scores.mjs [--bande=telephone] [--part=0/8]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadModel, predict } from "../../lib/smart-turn.mjs";
import { pcm8kVers16k } from "../../lib/telephone-16k.js";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(ICI, "fixtures", "eot-livekit");
const MODELE = path.join(ICI, "../../lib/modeles/smart-turn-v3.2-cpu.onnx");
const SORTIES = path.join(ICI, "../../.sorties");

const arg = (nom, defaut) => (process.argv.find((a) => a.startsWith(`--${nom}=`)) || `=${defaut}`).split("=").pop();
const BANDE = arg("bande", "telephone");
const [PART, PARTS] = arg("part", "0/1").split("/").map(Number);

// Les délais d'action balayés, en ms après le début du silence. Le pont tourne aujourd'hui à 900 ms de
// silence sec ; tout l'intérêt d'un modèle est de décider bien plus tôt sans couper davantage.
const DELAIS = [100, 150, 200, 250, 300, 350, 400, 500, 600, 700, 800, 1000, 1200];

// ---------- bande téléphonique : 16 kHz -> 8 kHz mu-law -> 16 kHz ----------

// RIF passe-bas à 3,4 kHz (la bande utile d'une ligne), 63 coefficients, avant de jeter un échantillon sur
// deux. Sans lui, tout ce qui est au-dessus de 4 kHz se replie dans la bande audible et on mesurerait un
// artefact de notre propre fabrication.
const ANTIREPLI = (() => {
  const taps = 63, coupure = 3400 / 16000, centre = (taps - 1) / 2;
  const h = new Float32Array(taps);
  let somme = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - centre;
    const sinc = n === 0 ? 2 * coupure : Math.sin(2 * Math.PI * coupure * n) / (Math.PI * n);
    h[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)));
    somme += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= somme;
  return h;
})();

function versMuLaw(echantillon) {
  const BIAIS = 0x84, MAX = 32635;
  let signe = (echantillon >> 8) & 0x80;
  if (signe !== 0) echantillon = -echantillon;
  if (echantillon > MAX) echantillon = MAX;
  echantillon += BIAIS;
  let exposant = 7;
  for (let masque = 0x4000; (echantillon & masque) === 0 && exposant > 0; exposant--, masque >>= 1);
  const mantisse = (echantillon >> (exposant + 3)) & 0x0f;
  return ~(signe | (exposant << 4) | mantisse) & 0xff;
}

function depuisMuLaw(octet) {
  const BIAIS = 0x84;
  octet = ~octet & 0xff;
  const signe = octet & 0x80, exposant = (octet >> 4) & 0x07, mantisse = octet & 0x0f;
  let v = ((mantisse << 3) + BIAIS) << exposant;
  v -= BIAIS;
  return signe !== 0 ? -v : v;
}

/** Float32 16 kHz -> ce que le pont recevrait de Twilio, puis remonté à 16 kHz pour le modèle. */
function passerParLaLigne(pcm16k) {
  const taps = ANTIREPLI.length, centre = (taps - 1) >> 1;
  const n8 = Math.floor(pcm16k.length / 2);
  const octets = Buffer.allocUnsafe(n8 * 2);
  for (let i = 0; i < n8; i++) {
    let acc = 0;
    const base = i * 2 - centre;
    for (let k = 0; k < taps; k++) {
      const j = base + k;
      if (j >= 0 && j < pcm16k.length) acc += ANTIREPLI[k] * pcm16k[j];
    }
    const entier = Math.max(-32768, Math.min(32767, Math.round(acc * 32768)));
    octets.writeInt16LE(depuisMuLaw(versMuLaw(entier)), i * 2); // aller-retour mu-law : la quantification de la ligne
  }
  return pcm8kVers16k(octets).pcm;
}

// ---------- lecture WAV ----------

function lireWav(fichier) {
  const buf = fs.readFileSync(fichier);
  let off = 12;
  while (off < buf.length - 8) {
    const id = buf.toString("ascii", off, off + 4);
    const taille = buf.readUInt32LE(off + 4);
    if (id === "data") {
      const n = taille / 2;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
      return out;
    }
    off += 8 + taille + (taille & 1);
  }
  throw new Error("pas de chunk data : " + fichier);
}

// ---------- passage ----------

const manifeste = JSON.parse(fs.readFileSync(path.join(CORPUS, "manifeste.json"), "utf8"));
const tours = manifeste.liste.filter((_, i) => i % PARTS === PART);
const session = await loadModel(MODELE, 1);
fs.mkdirSync(SORTIES, { recursive: true });

const resultats = [];
let inferences = 0;
const depart = Date.now();

for (const tour of tours) {
  const brut = lireWav(path.join(CORPUS, tour.fichier));
  const pcm = BANDE === "telephone" ? passerParLaLigne(brut) : brut;
  const spans = [];
  for (const span of tour.spans) {
    const longueurMs = (span.fin - span.debut) * 1000;
    const scores = {};
    for (const d of DELAIS) {
      // Une hésitation ne se décide que tant qu'elle dure : après, le client a déjà repris.
      if (span.etiquette === "hold" && d - longueurMs > 1e-6) continue;
      const fin = Math.min(pcm.length, Math.round((span.debut + d / 1000) * 16000));
      if (fin <= 0) continue;
      const debut = Math.max(0, fin - 8 * 16000);
      scores[d] = Number((await predict(session, pcm.subarray(debut, fin))).toFixed(5));
      inferences++;
    }
    spans.push({ debut: span.debut, fin: span.fin, etiquette: span.etiquette, scores });
  }
  resultats.push({ id: tour.id, duree: tour.duree, spans });
  if (resultats.length % 10 === 0) {
    const parSeconde = inferences / ((Date.now() - depart) / 1000);
    process.stdout.write(`[${BANDE} ${PART}/${PARTS}] ${resultats.length}/${tours.length} tours, ${inferences} inférences, ${parSeconde.toFixed(1)}/s\n`);
  }
}

const sortie = path.join(SORTIES, `eot-scores-${BANDE}-${PART}.json`);
fs.writeFileSync(sortie, JSON.stringify({ bande: BANDE, part: PART, parts: PARTS, delais: DELAIS, tours: resultats }));
console.log(`[${BANDE} ${PART}/${PARTS}] fini : ${resultats.length} tours, ${inferences} inférences en ${((Date.now() - depart) / 1000).toFixed(0)} s -> ${sortie}`);
