// Fabrique le jeu d'épreuve de la DÉTECTION DE FIN DE TOUR : des phrases françaises de client, avec des
// pauses placées au millimètre, pour mesurer ce qu'un réglage coupe et ce qu'il fait attendre.
//
// Pourquoi le fabriquer au lieu de rejouer de vrais appels : nos enregistrements viennent d'appelants scriptés
// (Polly à pauses fixes), et les rares vrais appels ne sont pas enregistrés. Surtout, un jeu d'épreuve utile
// demande de SAVOIR où sont les pauses à la milliseconde près, ce qu'aucun enregistrement réel ne donne.
// La limite est assumée et doit être dite : ce sont des voix de synthèse, leurs pauses sont propres, et un
// humain qui hésite fait des bruits (« euh », inspiration, claquement de langue) qu'on ne reproduit qu'en
// partie ici. Les seuils trouvés ici sont un point de départ, pas un verdict : le verdict se prend sur de
// vrais appels.
//
// Deux familles, et c'est toute la question :
//   FINI     la phrase est terminée, l'agent DOIT répondre vite. Tout retard est de la latence pure.
//   PAUSE    le client marque un temps et REPREND. Répondre pendant la pause, c'est lui couper la parole.
//
// Usage : node test/bancs/fabriquer-pauses.mjs [voix]
// Sortie : test/bancs/fixtures/pauses/<id>.wav (PCM 16 bits 8 kHz mono) + pauses.json qui dit, pour chaque
// fichier, où finit chaque segment de parole et si la phrase continue après.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const SORTIE = path.join(ICI, "fixtures", "pauses");
fs.mkdirSync(SORTIE, { recursive: true });
const vault = fs.readFileSync(process.env.VAULT || "C:/Users/msi/.secrets/api-keys.env", "utf8");
const CLE = (vault.match(/^OPENAI_API_KEY=(.*)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
const VOIX = process.argv[2] || "nova";

// Chaque cas : des segments de parole séparés par des silences de durée connue. `suite: true` sur un silence
// veut dire que le client N'A PAS fini : couper là est une faute.
const CAS = [
  // --- Phrases terminées : répondre vite est la seule chose à faire ---
  { id: "fini-horaires", segments: [{ dire: "Bonjour, vous êtes ouverts jusqu'à quelle heure ce soir ?" }] },
  { id: "fini-adresse", segments: [{ dire: "Vous êtes bien route de Montpellier ?" }] },
  { id: "fini-commande", segments: [{ dire: "Je voudrais deux Regina et une Veggie." }] },
  { id: "fini-court", segments: [{ dire: "Oui, c'est ça." }] },
  { id: "fini-tres-court", segments: [{ dire: "D'accord." }] },
  { id: "fini-prenom", segments: [{ dire: "C'est au nom de Julien." }] },

  // --- Pauses d'hésitation : le client reprend, couper serait une faute ---
  { id: "pause-euh-400", segments: [{ dire: "Je voudrais euh" }, { silence: 400, suite: true }, { dire: "deux pizzas." }] },
  { id: "pause-euh-700", segments: [{ dire: "Alors ce serait pour" }, { silence: 700, suite: true }, { dire: "quatre personnes." }] },
  { id: "pause-reflexion-1000", segments: [{ dire: "Attendez, je regarde" }, { silence: 1000, suite: true }, { dire: "alors, une Regina et une Diavola." }] },
  { id: "pause-longue-1400", segments: [{ dire: "Ce serait pour ce soir" }, { silence: 1400, suite: true }, { dire: "vers vingt heures trente si c'est possible." }] },
  { id: "pause-milieu-600", segments: [{ dire: "Est-ce que vous faites" }, { silence: 600, suite: true }, { dire: "des pizzas sans gluten ?" }] },

  // --- Épellation : le cas où un seuil court coupe systématiquement ---
  { id: "epelle-prenom", segments: [{ dire: "Ça s'écrit J" }, { silence: 500, suite: true }, { dire: "U" }, { silence: 500, suite: true }, { dire: "L" }, { silence: 500, suite: true }, { dire: "I" }, { silence: 450, suite: true }, { dire: "E" }, { silence: 450, suite: true }, { dire: "N." }] },
  { id: "epelle-telephone", segments: [{ dire: "Mon numéro c'est zéro six" }, { silence: 600, suite: true }, { dire: "douze" }, { silence: 550, suite: true }, { dire: "trente-quatre" }, { silence: 550, suite: true }, { dire: "cinquante-six" }, { silence: 500, suite: true }, { dire: "soixante-dix-huit." }] },
  { id: "epelle-mail", segments: [{ dire: "C'est julien point martin" }, { silence: 700, suite: true }, { dire: "arobase gmail point com." }] },

  // --- Le client se reprend : deux phrases, la première abandonnée ---
  { id: "reprise-changement", segments: [{ dire: "Je voudrais une Regina, ah non" }, { silence: 500, suite: true }, { dire: "plutôt une Rucola." }] },

  // --- Acquiescements : ne doivent JAMAIS déclencher une réponse à eux seuls ---
  { id: "backchannel-mmm", segments: [{ dire: "Mmm." }] },
  { id: "backchannel-oui", segments: [{ dire: "Oui." }] },
  { id: "backchannel-daccord", segments: [{ dire: "Ah d'accord." }] },
];

async function dire(texte) {
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${CLE}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: VOIX, input: texte, response_format: "pcm", speed: 1.0,
      instructions: "Parle en français, au téléphone, d'un ton naturel de client qui commande une pizza. Ne fais aucune pause supplémentaire, dis juste le texte." }),
  });
  if (!r.ok) throw new Error(`TTS ${r.status} : ${(await r.text()).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer()); // PCM 16 bits 24 kHz mono
}

// 24 kHz -> 8 kHz par moyenne de 3 échantillons : suffisant et sans repliement audible sur de la voix.
function vers8k(pcm24) {
  const n = Math.floor(pcm24.length / 2 / 3);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const a = pcm24.readInt16LE(i * 6), b = pcm24.readInt16LE(i * 6 + 2), c = pcm24.readInt16LE(i * 6 + 4);
    out.writeInt16LE(Math.round((a + b + c) / 3), i * 2);
  }
  return out;
}
const silence8k = (ms) => Buffer.alloc(Math.round((ms / 1000) * 8000) * 2);

// ⚠ LE PIÈGE DE CE BANC : la synthèse pose son PROPRE silence en tête et en queue de chaque segment. Sans
// rognage, une « pause de 400 ms » insérée entre deux segments en mesure 1040 sur le fichier, et tous les
// repères mentent : on croit mesurer un seuil à 400 ms alors qu'on en mesure un à 1040. Constaté en traçant
// la détection sur `pause-euh-400`. On rogne donc chaque segment à sa vraie parole avant de l'assembler.
function rogner(pcm) {
  const par = 160; // 20 ms à 8 kHz
  const n = Math.floor(pcm.length / 2 / par);
  const fort = [];
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (let i = k * par; i < (k + 1) * par; i++) { const v = pcm.readInt16LE(i * 2); s += v * v; }
    fort.push(Math.sqrt(s / par) >= 300); // moitié du seuil du pont : on rogne le silence, pas la voix faible
  }
  const de = fort.indexOf(true), a = fort.lastIndexOf(true);
  if (de < 0) return pcm;
  return pcm.subarray(de * par * 2, Math.min(pcm.length, (a + 1) * par * 2));
}
function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const index = [];
for (const cas of CAS) {
  const morceaux = [];
  // { debutParoleMs, finParoleMs, suite } : les DEUX bornes de chaque segment parlé sont nécessaires. Sans le
  // début du segment suivant, on ne sait pas où finit la pause, et on compte comme « coupure » une décision
  // prise bien après que le client a repris.
  const reperes = [];
  let msCumul = 0;
  for (const s of cas.segments) {
    if (s.dire) {
      const pcm = rogner(vers8k(await dire(s.dire)));
      const debut = Math.round(msCumul);
      morceaux.push(pcm);
      msCumul += (pcm.length / 2 / 8000) * 1000;
      reperes.push({ debutParoleMs: debut, finParoleMs: Math.round(msCumul), suite: false });
    } else if (s.silence) {
      if (reperes.length) reperes[reperes.length - 1].suite = Boolean(s.suite);
      morceaux.push(silence8k(s.silence));
      msCumul += s.silence;
    }
  }
  // Deux secondes de silence à la fin : le dernier segment doit être reconnu comme une fin de tour MÊME par
  // les délais les plus longs qu'on veut balayer, sinon la colonne latence tombe à zéro faute de décision.
  morceaux.push(silence8k(2000));
  const fichier = path.join(SORTIE, `${cas.id}.wav`);
  fs.writeFileSync(fichier, wav(Buffer.concat(morceaux)));
  index.push({ id: cas.id, fichier: path.basename(fichier), dureeMs: Math.round(msCumul + 1000), reperes,
    famille: cas.id.split("-")[0] });
  console.log(`${cas.id.padEnd(22)} ${Math.round(msCumul + 1000)} ms, ${reperes.length} segment(s), ${reperes.filter((r) => r.suite).length} pause(s) suivie(s) d'une reprise`);
}
fs.writeFileSync(path.join(SORTIE, "pauses.json"), JSON.stringify({ voix: VOIX, rate: 8000, cas: index }, null, 2));
console.log(`\n${index.length} fichiers dans ${SORTIE}`);
