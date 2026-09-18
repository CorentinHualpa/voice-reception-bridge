// `audio.input.transport` et `audio.output.transport` = "binary" (doc xAI) : les trames WebSocket portent les
// octets bruts du codec, sans en-tete JSON ni base64. La doc le justifie par la suppression du surcout base64
// et n'annonce AUCUN gain chiffre. Ce banc le mesure : meme session, memes questions, en alternance, et on
// compare le premier son. Le base64 coute 33 % d'octets sur un flux mu-law 8 kHz, soit ~2,7 ko/s : l'effet
// attendu sur la latence est faible, le but est de savoir s'il est mesurable ou sous le bruit.
//
// Usage : node test/bancs/banc-transport-binaire.mjs [N=15]
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(ICI, "fixtures");
const vault = fs.readFileSync(process.env.VAULT || "C:/Users/msi/.secrets/api-keys.env", "utf8");
const CLE = (vault.match(/^XAI_API_KEY=(.*)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
const N = Number(process.argv[2] || 15);
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const session = JSON.parse(fs.readFileSync(path.join(FIXTURES, "session-palazzo.json"), "utf8"));

const QUESTIONS = [
  "Bonjour, vous etes ouverts jusqu'a quelle heure ce soir ?",
  "Vous etes bien route de Montpellier ?",
  "Il y a quoi sur la Regina ?",
  "Vous avez des desserts ?",
  "C'est combien la plus grande pizza ?",
];

function percentile(tab, p) {
  const t = tab.slice().sort((a, b) => a - b);
  return t.length ? t[Math.min(t.length - 1, Math.floor(t.length * p))] : null;
}
const resume = (nom, sons) => {
  const pics = sons.filter((s) => s >= 2000);
  console.log(`${nom.padEnd(10)} n=${String(sons.length).padStart(3)}  mediane ${String(percentile(sons, 0.5)).padStart(5)} ms  p75 ${String(percentile(sons, 0.75)).padStart(5)}  p90 ${String(percentile(sons, 0.9)).padStart(5)}  max ${String(Math.max(...sons)).padStart(5)}  pics>2s ${pics.length}/${sons.length}`);
};

async function ouvrir(transport) {
  const tok = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
    method: "POST", headers: { Authorization: `Bearer ${CLE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expires_after: { seconds: 900 } }),
  }).then((r) => r.json());
  const ws = new WebSocket("wss://api.x.ai/v1/realtime?model=grok-voice-latest&reasoning.effort=none",
    [`xai-client-secret.${tok.value || tok.client_secret?.value}`]);
  ws.binaryType = "arraybuffer";
  await new Promise((ok) => { ws.onopen = ok; });
  const evts = [];
  let octetsBinaires = 0, premierBinaireA = 0;
  ws.onmessage = (m) => {
    if (typeof m.data !== "string") { // trame binaire : de l'audio brut, pas un evenement
      octetsBinaires += m.data.byteLength ?? m.data.length ?? 0;
      if (!premierBinaireA) premierBinaireA = Date.now();
      return;
    }
    const e = JSON.parse(m.data); e._a = Date.now(); evts.push(e);
  };
  ws.send(JSON.stringify({ type: "session.update", session: {
    instructions: session.instructions,
    voice: "carina", reasoning: { effort: "none" },
    audio: {
      input: { format: { type: "audio/pcmu", rate: 8000 }, turn_detection: null, ...(transport ? { transport } : {}) },
      output: { format: { type: "audio/pcmu", rate: 8000 }, speed: 1.1, ...(transport ? { transport } : {}) },
    },
  } }));
  for (let i = 0; i < 100 && !evts.some((e) => e.type === "session.updated"); i++) await attendre(100);
  const maj = evts.find((e) => e.type === "session.updated");
  return { ws, evts, maj, reset: () => { octetsBinaires = 0; premierBinaireA = 0; }, lire: () => ({ octetsBinaires, premierBinaireA }) };
}

async function tour(s, texte) {
  const avant = s.evts.length;
  s.reset();
  s.ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: texte }] } }));
  const d = Date.now();
  s.ws.send(JSON.stringify({ type: "response.create" }));
  let fin = null;
  for (let k = 0; k < 600 && !fin; k++) { await attendre(25); fin = s.evts.slice(avant).find((e) => e.type === "response.done"); }
  const ev = s.evts.slice(avant);
  const delta = ev.find((x) => x.type === "response.output_audio.delta");
  const { octetsBinaires, premierBinaireA } = s.lire();
  // Le premier son est soit un delta JSON, soit la premiere trame binaire, selon le transport.
  const son = premierBinaireA ? premierBinaireA - d : (delta ? delta._a - d : null);
  return { son, binaire: octetsBinaires > 0, octetsBinaires, deltasJson: ev.filter((x) => x.type === "response.output_audio.delta").length };
}

for (const transport of ["json", "binary"]) {
  const s = await ouvrir(transport);
  const accepte = JSON.stringify(s.maj?.session?.audio?.output?.transport ?? s.maj?.session?.audio ?? {}).slice(0, 120);
  const sons = [];
  let binaireVu = false, deltasJson = 0;
  for (let i = 0; i < N; i++) {
    const r = await tour(s, QUESTIONS[i % QUESTIONS.length]);
    if (r.son != null) sons.push(r.son);
    binaireVu = binaireVu || r.binaire;
    deltasJson += r.deltasJson;
    await attendre(300);
  }
  s.ws.close();
  console.log(`\ntransport "${transport}" : session.updated dit ${accepte}`);
  console.log(`  trames binaires recues : ${binaireVu ? "OUI" : "non"}, deltas JSON : ${deltasJson}`);
  resume(transport, sons);
  console.log(`  ordre : ${sons.join(" ")}`);
}
console.log("\nSi les deux medianes se tiennent a quelques dizaines de ms, le binaire ne se mesure pas ici et ne");
console.log("vaut que pour le CPU et la bande passante. S'il n'y a aucune trame binaire, xAI a ignore le reglage.");
process.exit(0);
