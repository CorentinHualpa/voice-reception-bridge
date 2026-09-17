// Banc du détecteur de parole de Grok sur une vraie voix de client : on rejoue en temps réel la question de
// l'appel de test (voie client), et on lit quand Grok dit que la parole commence, finit, et quand il crée
// sa réponse, pour plusieurs seuils et délais de silence. Clé xAI lue dans le vault, jamais affichée.
// Usage : node banc-vad-grok.mjs <wav voie client> <debut s> <fin s> <parole debut s> <parole fin s> [essais=1]
import path from "node:path";
import { fileURLToPath } from "node:url";
const ICI = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(ICI, "fixtures");
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const [wav, a, b, pa, pb, essaisArg] = process.argv.slice(2);
const DEBUT = Number(a), FIN = Number(b), PAROLE_DEBUT = Number(pa) - DEBUT, PAROLE_FIN = Number(pb) - DEBUT;
const ESSAIS = Number(essaisArg || 1);
const vault = fs.readFileSync(process.env.VAULT || "C:/Users/msi/.secrets/api-keys.env", "utf8");
const CLE = (vault.match(/^XAI_API_KEY=(.*)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
const pcm = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(DEBUT), "-to", String(FIN), "-i", wav, "-f", "s16le", "-ac", "1", "-ar", "8000", "-"], { maxBuffer: 64 * 1024 * 1024 });
const silence = Buffer.alloc(8000 * 2 * 3); // 3 s de silence après le morceau

async function essai(seuil, silenceMs) {
  const tok = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
    method: "POST", headers: { Authorization: `Bearer ${CLE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expires_after: { seconds: 120 } }),
  }).then((r) => r.json());
  const ws = new WebSocket("wss://api.x.ai/v1/realtime?model=grok-voice-latest", [`xai-client-secret.${tok.value || tok.client_secret?.value}`]);
  const res = {};
  let t0 = 0;
  await new Promise((ok, ko) => { ws.onopen = ok; ws.onerror = () => ko(new Error("ws")); });
  const pret = new Promise((ok) => {
    ws.onmessage = (m) => {
      const e = JSON.parse(m.data);
      const w = t0 ? Date.now() - t0 : null;
      if (e.type === "session.updated") ok();
      else if (e.type === "input_audio_buffer.speech_started" && res.debut == null) Object.assign(res, { debut: e.audio_start_ms, debutRecu: w });
      else if (e.type === "input_audio_buffer.speech_stopped" && res.fin == null) Object.assign(res, { fin: e.audio_end_ms, finRecue: w });
      else if (e.type === "response.created" && res.creee == null) res.creee = w;
      else if (e.type === "response.output_audio.delta" && res.son == null) res.son = w;
      else if (e.type === "error") res.erreur = JSON.stringify(e.error || e).slice(0, 160);
    };
  });
  ws.send(JSON.stringify({ type: "session.update", session: {
    instructions: "Tu es un serveur de pizzeria au téléphone. Réponds en une phrase courte.", voice: "eve", reasoning: { effort: "none" },
    turn_detection: { type: "server_vad", threshold: seuil, prefix_padding_ms: 300, silence_duration_ms: silenceMs },
    audio: { input: { format: { type: "audio/pcm", rate: 8000 } }, output: { format: { type: "audio/pcm", rate: 8000 } } },
  } }));
  await pret;
  const tout = Buffer.concat([pcm, silence]);
  t0 = Date.now();
  for (let o = 0, k = 0; o < tout.length; o += 320, k++) {
    const attendre = t0 + k * 20 - Date.now();
    if (attendre > 0) await new Promise((r) => setTimeout(r, attendre));
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: tout.subarray(o, o + 320).toString("base64") }));
  }
  await new Promise((r) => setTimeout(r, 1500));
  ws.close();
  const ms = (x) => (x == null ? "  -  " : String(Math.round(x)).padStart(5));
  const f = PAROLE_FIN * 1000, d = PAROLE_DEBUT * 1000;
  console.log(`seuil ${seuil} silence ${String(silenceMs).padStart(4)} | debut ${ms(res.debut - d)} (recu ${ms(res.debutRecu - d)}) | fin ${ms(res.fin - f)} (recue ${ms(res.finRecue - f)}) | reponse creee ${ms(res.creee - f)} | premier son ${ms(res.son - f)} ms apres la vraie fin${res.erreur ? " | " + res.erreur : ""}`);
}

for (let i = 0; i < ESSAIS; i++) for (const [seuil, sil] of [[0.5, 600], [0.5, 400], [0.85, 600], [0.85, 400], [0.7, 500]]) {
  try { await essai(seuil, sil); } catch (err) { console.log(`seuil ${seuil} silence ${sil} : échec ${err.message}`); }
}
