// LA question qui décide du chantier : Smart Turn v3 sait-il encore juger une fin de tour quand l'audio a
// traversé une ligne téléphonique ?
//
// Le modèle est entraîné en 16 kHz large bande. Une ligne téléphonique ne porte rien au-dessus de ~3,4 kHz,
// donc la moitié des bandes mel qu'il regarde est vide, quoi qu'on fasse au rééchantillonnage. Aucun benchmark
// public ne mesure ça : la carte du modèle est muette, et Pipecat l'utilise en 8 kHz sans publier de chiffre.
//
// Protocole : le MÊME texte, dit par la MÊME voix, comparé en deux versions.
//   large bande  la synthèse à 24 kHz descendue à 16 kHz (ce que le modèle a vu à l'entraînement)
//   téléphone    la même descendue à 8 kHz puis remontée à 16 kHz (ce que notre pont lui donne)
// On lit la probabilité de fin de tour aux deux endroits qui comptent : à la fin d'une phrase TERMINÉE (elle
// doit être haute) et au creux d'une PAUSE suivie d'une reprise (elle doit être basse).
//
// Usage : node test/bancs/banc-smart-turn-bande.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadModel, predict } from "../../lib/smart-turn.mjs";
import { pcm8kVers16k } from "../../lib/telephone-16k.js";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const MODELE = path.join(ICI, "../../lib/modeles/smart-turn-v3.2-cpu.onnx");
const vault = fs.readFileSync(process.env.VAULT || "C:/Users/msi/.secrets/api-keys.env", "utf8");
const CLE = (vault.match(/^OPENAI_API_KEY=(.*)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");

// Chaque cas : ce qui est dit, et ce que le modèle DEVRAIT répondre.
const CAS = [
  { texte: "Bonjour, vous êtes ouverts jusqu'à quelle heure ce soir ?", attendu: "FINI" },
  { texte: "Je voudrais deux Regina et une Veggie.", attendu: "FINI" },
  { texte: "C'est au nom de Julien.", attendu: "FINI" },
  { texte: "D'accord.", attendu: "FINI" },
  { texte: "Je voudrais euh", attendu: "PAS FINI" },
  { texte: "Alors ce serait pour", attendu: "PAS FINI" },
  { texte: "Est-ce que vous faites", attendu: "PAS FINI" },
  { texte: "Attendez, je regarde", attendu: "PAS FINI" },
  { texte: "Mon numéro c'est zéro six", attendu: "PAS FINI" },
  { texte: "Ça s'écrit J", attendu: "PAS FINI" },
];

async function dire(texte) {
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST", headers: { Authorization: `Bearer ${CLE}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "nova", input: texte, response_format: "pcm", speed: 1.0,
      instructions: "Parle en français, au téléphone, d'un ton naturel de client qui commande une pizza. Ne fais aucune pause supplémentaire." }),
  });
  if (!r.ok) throw new Error(`TTS ${r.status}`);
  return Buffer.from(await r.arrayBuffer()); // PCM16 24 kHz
}

// 24 kHz -> 16 kHz : 3 échantillons d'entrée pour 2 de sortie, par interpolation linéaire. Suffisant ici,
// on compare deux chaînes entre elles et non la fidélité absolue.
function vers16k(pcm24) {
  const n = Math.floor(pcm24.length / 2);
  const m = Math.floor((n * 2) / 3);
  const out = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    const src = (i * 3) / 2;
    const a = Math.floor(src), f = src - a;
    const v0 = pcm24.readInt16LE(Math.min(n - 1, a) * 2);
    const v1 = pcm24.readInt16LE(Math.min(n - 1, a + 1) * 2);
    out[i] = (v0 * (1 - f) + v1 * f) / 32768;
  }
  return out;
}
// 24 kHz -> 8 kHz (la ligne téléphonique) puis 8 -> 16 kHz (ce que notre pont fait)
function versTelephone(pcm24) {
  const n = Math.floor(pcm24.length / 2 / 3);
  const pcm8 = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const a = pcm24.readInt16LE(i * 6), b = pcm24.readInt16LE(i * 6 + 2), c = pcm24.readInt16LE(i * 6 + 4);
    pcm8.writeInt16LE(Math.round((a + b + c) / 3), i * 2);
  }
  return pcm8kVers16k(pcm8).pcm;
}
// Une seconde de silence derrière : c'est ce que le modèle voit au moment où on l'interroge.
function avecSilence(f32, ms = 300) {
  const out = new Float32Array(f32.length + Math.round((ms / 1000) * 16000));
  out.set(f32);
  return out;
}

const session = await loadModel(MODELE, 4);
console.log("                                            large bande   téléphone   écart");
console.log("─".repeat(92));
const ecarts = [];
let justesLarge = 0, justesTel = 0;
for (const cas of CAS) {
  const pcm24 = await dire(cas.texte);
  const pLarge = await predict(session, avecSilence(vers16k(pcm24)));
  const pTel = await predict(session, avecSilence(versTelephone(pcm24)));
  const bon = (p) => (cas.attendu === "FINI" ? p > 0.5 : p <= 0.5);
  if (bon(pLarge)) justesLarge++;
  if (bon(pTel)) justesTel++;
  ecarts.push(pTel - pLarge);
  const etiquette = `${cas.attendu.padEnd(9)} « ${cas.texte.slice(0, 30)}${cas.texte.length > 30 ? "…" : ""} »`;
  console.log(`${etiquette.padEnd(46)} ${pLarge.toFixed(3).padStart(9)}${bon(pLarge) ? " " : "✗"}  ` +
    `${pTel.toFixed(3).padStart(9)}${bon(pTel) ? " " : "✗"}  ${(pTel - pLarge >= 0 ? "+" : "") + (pTel - pLarge).toFixed(3)}`);
}
const moy = ecarts.reduce((s, x) => s + x, 0) / ecarts.length;
console.log("─".repeat(92));
console.log(`justes : ${justesLarge}/${CAS.length} en large bande, ${justesTel}/${CAS.length} au téléphone`);
console.log(`écart moyen de probabilité : ${(moy >= 0 ? "+" : "") + moy.toFixed(3)}`);
console.log("\nUn écart positif veut dire que la ligne téléphonique pousse le modèle à croire que le tour est FINI,");
console.log("donc à couper la parole. C'est exactement ce qu'on cherche à savoir.");
process.exit(0);
