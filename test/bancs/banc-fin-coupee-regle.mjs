// Quelle tournure perd sa fin, et le son manquant arrive-t-il APRÈS response.done ? Une session (pcm 8 kHz, comme le
// pont), chaque phrase dite mot pour mot 3 fois ; tous les événements sont gardés 2,5 s après response.done.
// Usage : node test/bancs/banc-fin-coupee-regle.mjs [voix=carina] [essais=3] [vitesse=1.1] [phrases séparées par des virgules]
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const S = path.join(ICI, ".sorties", "fin-coupee-regle");
fs.mkdirSync(S, { recursive: true });
const vault = fs.readFileSync(process.env.VAULT || "C:/Users/msi/.secrets/api-keys.env", "utf8");
const cle = (n) => (vault.match(new RegExp(`^${n}=(.*)$`, "m"))?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
const VOIX = process.argv[2] || "carina";
const N = Number(process.argv[3] || 3);
const VITESSE = Number(process.argv[4] || 1.1);
const SEULES = process.argv[5] ? process.argv[5].split(",") : null;
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const PHRASES = [
  ["seule", "C'est pour quel prénom ?", /pr[ée]nom/i],
  ["apres-phrase", "Très bien. C'est pour quel prénom ?", /pr[ée]nom/i],
  ["une-phrase", "Très bien, c'est pour quel prénom ?", /pr[ée]nom/i],
  ["plus-longue", "Très bien. Et c'est à quel prénom, s'il vous plaît ?", /pla[iî]t/i],
  ["point-final", "Très bien. C'est pour quel prénom.", /pr[ée]nom/i],
  ["je-vous-ecoute", "Très bien. C'est pour quel prénom ? Je vous écoute.", /[ée]coute/i],
  ["votre-prenom", "Très bien. Votre prénom, s'il vous plaît ?", /pla[iî]t/i],
  ["commander", "Allora, que désirez-vous commander ?", /commander/i],
  ["sans-espace", "Très bien. C'est pour quel prénom?", /pr[ée]nom/i],
  ["espace-fine", "Très bien. C'est pour quel prénom ?", /pr[ée]nom/i],
  ["commander-sans-espace", "Allora, que désirez-vous commander?", /commander/i],
  ["deux-questions", "Elle est à onze euros. Vous la prenez ?", /prenez/i],
  ["deux-questions-sans-espace", "Elle est à onze euros. Vous la prenez?", /prenez/i],
];
async function transcrire(fichier) {
  const fd = new FormData();
  fd.append("file", new Blob([fs.readFileSync(fichier)], { type: "audio/wav" }), "r.wav");
  fd.append("model", "gpt-4o-transcribe");
  fd.append("language", "fr");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${cle("OPENAI_API_KEY")}` }, body: fd });
  return r.ok ? ((await r.json()).text || "").trim() : `(erreur ${r.status})`;
}
const wav = (pcm) => { const h = Buffer.alloc(44); h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]); };

const tok = await fetch("https://api.x.ai/v1/realtime/client_secrets", { method: "POST", headers: { Authorization: `Bearer ${cle("XAI_API_KEY")}`, "Content-Type": "application/json" }, body: JSON.stringify({ expires_after: { seconds: 900 } }) }).then((r) => r.json());
const ws = new WebSocket("wss://api.x.ai/v1/realtime?model=grok-voice-latest", [`xai-client-secret.${tok.value || tok.client_secret?.value}`]);
await new Promise((ok) => { ws.onopen = ok; });
const evts = [];
ws.onmessage = (m) => { const e = JSON.parse(m.data); e._a = Date.now(); evts.push(e); };
ws.send(JSON.stringify({ type: "session.update", session: {
  instructions: "Tu es Chiara, au téléphone chez Palazzo Pizza. Tu dis exactement les phrases demandées.",
  voice: VOIX, reasoning: { effort: "none" },
  audio: { input: { format: { type: "audio/pcm", rate: 8000 }, turn_detection: null }, output: { format: { type: "audio/pcm", rate: 8000 }, speed: VITESSE } },
} }));
for (let i = 0; i < 80 && !evts.some((e) => e.type === "session.updated"); i++) await attendre(100);
const lignes = [];
for (let n = 0; n < N; n++) {
  for (const [nom, texte] of PHRASES.filter(([p]) => !SEULES || SEULES.includes(p))) {
    const debut = evts.length;
    ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "(SYSTÈME : phrase suivante.)" }] } }));
    ws.send(JSON.stringify({ type: "response.create", response: { instructions: `Dis exactement cette phrase, mot pour mot, sans rien ajouter avant ni après : « ${texte} »` } }));
    let done = null;
    for (let k = 0; k < 300 && !done; k++) { await attendre(25); done = evts.slice(debut).find((e) => e.type === "response.done"); }
    await attendre(2500); // on garde tout ce qui arrive encore après la fin annoncée
    const ev = evts.slice(debut);
    const deltas = ev.filter((e) => e.type === "response.output_audio.delta");
    const tardifs = done ? deltas.filter((e) => e._a > done._a) : [];
    const pcmTout = Buffer.concat(deltas.map((e) => Buffer.from(e.delta, "base64")));
    const pcm = pcmTout.subarray(0, pcmTout.length - (pcmTout.length % 2));
    const fichier = path.join(S, `${VOIX}-v${VITESSE}-${nom}-${n + 1}.wav`);
    fs.writeFileSync(fichier, wav(pcm));
    const texteGrok = ev.filter((e) => e.type === "response.output_audio_transcript.delta").map((e) => e.delta || "").join("").trim();
    const audioDone = ev.find((e) => e.type === "response.output_audio.done");
    lignes.push({ nom, n, fichier, duree: pcm.length / 16000, tardifs: tardifs.length, octetsTardifs: tardifs.reduce((s, e) => s + Buffer.from(e.delta, "base64").length, 0), texteGrok, dernierDelta: deltas.length && done ? deltas[deltas.length - 1]._a - done._a : null, audioDoneAvantDone: audioDone && done ? done._a - audioDone._a : null });
    evts.length = 0;
  }
}
ws.close();
await Promise.all(lignes.map(async (l) => { l.entendu = await transcrire(l.fichier); }));
for (const [nom, texte, dernier] of PHRASES) {
  const ls = lignes.filter((l) => l.nom === nom);
  if (!ls.length) continue;
  const perdus = ls.filter((l) => !dernier.test(l.entendu)).length;
  console.log(`${nom.padEnd(15)} « ${texte} » : dernier mot perdu ${perdus}/${ls.length} ; deltas après response.done : ${ls.map((l) => l.tardifs).join("/")} ; Grok « ${ls[0].texteGrok.slice(-30)} » ; entendu ${ls.map((l) => `« ${l.entendu.slice(-26)} »`).join(" ")}`);
}
process.exit(0);
