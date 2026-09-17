// Grok arrête sa réponse dès qu'il entend le client pendant qu'il la génère. Trois sessions neuves, même
// question en mode manuel : A sans bruit (témoin), B avec un « Mmm » envoyé en direct pendant la génération,
// C avec le même « Mmm » retenu par le client puis envoyé d'un bloc après response.done (ce que ferait le pont).
import path from "node:path";
import { fileURLToPath } from "node:url";
const ICI = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(ICI, "fixtures");
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const S = process.env.BANC_SORTIE || path.join(ICI, ".sorties");
fs.mkdirSync(S, { recursive: true });
const vault = fs.readFileSync(process.env.VAULT || "C:/Users/msi/.secrets/api-keys.env", "utf8");
const CLE = (vault.match(/^XAI_API_KEY=(.*)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
const extrait = (a, b) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(a), "-to", String(b), "-i", `${path.join(FIXTURES, "client-polly.wav")}`, "-f", "s16le", "-ac", "1", "-ar", "8000", "-"], { maxBuffer: 64 * 1024 * 1024 });
const question = Buffer.concat([extrait(14.8, 18.9), Buffer.alloc(8000)]);
const mmm = Buffer.concat([extrait(22.2, 23.4), Buffer.alloc(4000)]);
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(mode) {
  const tok = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
    method: "POST", headers: { Authorization: `Bearer ${CLE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expires_after: { seconds: 120 } }),
  }).then((r) => r.json());
  const ws = new WebSocket("wss://api.x.ai/v1/realtime?model=grok-voice-latest", [`xai-client-secret.${tok.value || tok.client_secret?.value}`]);
  const r = { audioMs: 0, texte: "", statut: null, reponses: 0 };
  let actif = false;
  await new Promise((ok) => { ws.onopen = ok; });
  const pret = new Promise((ok) => {
    ws.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === "session.updated") ok();
      else if (e.type === "response.created") { r.reponses++; actif = true; }
      else if (e.type === "response.output_audio.delta") r.audioMs += (Buffer.from(e.delta, "base64").length / 2 / 8000) * 1000;
      else if (e.type === "response.output_audio_transcript.delta") r.texte += e.delta || "";
      else if (e.type === "response.done") { actif = false; r.statut = e.response?.status; }
      else if (e.type === "error") r.erreur = JSON.stringify(e.error || e).slice(0, 160);
    };
  });
  ws.send(JSON.stringify({ type: "session.update", session: {
    instructions: "Tu es serveur dans une pizzeria au téléphone. Quand on te demande les pizzas au jambon, tu les cites toutes avec leurs ingrédients : Roma (sauce tomate, mozzarella, jambon blanc, olives), Regina (crème, mozzarella, jambon blanc, champignons, olives), Pacino (sauce tomate, mozzarella, jambon blanc, spianata piquante, poivrons), Parma (sauce tomate, burrata, jambon de Parme, roquette, parmesan). Puis tu demandes laquelle tente le client.",
    voice: "eve", reasoning: { effort: "none" }, turn_detection: {},
    audio: { input: { format: { type: "audio/pcm", rate: 8000 } }, output: { format: { type: "audio/pcm", rate: 8000 } } },
  } }));
  await pret;
  const jouer = async (buf) => { const d = Date.now(); for (let o = 0, k = 0; o < buf.length; o += 320, k++) { const w = d + k * 20 - Date.now(); if (w > 0) await attendre(w); ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: buf.subarray(o, o + 320).toString("base64") })); } };
  await jouer(question);
  ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  ws.send(JSON.stringify({ type: "response.create" }));
  for (let i = 0; i < 40 && !actif; i++) await attendre(50);
  await attendre(400);
  if (mode === "direct") await jouer(mmm);
  else if (mode === "retenu") { const retenu = mmm; await attendre(mmm.length / 16); for (let i = 0; i < 80 && actif; i++) await attendre(100); ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: retenu.toString("base64") })); ws.send(JSON.stringify({ type: "input_audio_buffer.clear" })); }
  for (let i = 0; i < 80 && actif; i++) await attendre(100);
  await attendre(1500);
  ws.close();
  console.log(`${mode.padEnd(7)} statut=${r.statut} audio=${(r.audioMs / 1000).toFixed(1)}s réponses=${r.reponses}${r.erreur ? " ERREUR " + r.erreur : ""}\n        « ${r.texte.slice(0, 220)} »`);
}

for (const mode of ["temoin", "direct", "retenu"]) await session(mode);
