// Banc du détecteur de parole de Grok sur la voix du client simulé : on rejoue en temps réel la demande de devis
// (1 s de silence avant, 3 s après) et on lit quand Grok dit que la parole commence, finit, et quand il crée sa
// réponse, pour plusieurs seuils et délais de silence. C'est ce qui justifie TOURS=pont.
// Usage : node test/bancs/banc-vad-grok.mjs [essais=1]
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, ouvrirGrok } from "./config-banc.mjs";

const ESSAIS = Number(process.argv[2] || 1);
const parole = fs.readFileSync(path.join(FIXTURES, "client-besoin.wav")).subarray(44);
const PAROLE_DEBUT = 1000, PAROLE_FIN = 1000 + (parole.length / 16000) * 1000;
const tout = Buffer.concat([Buffer.alloc(16000), parole, Buffer.alloc(48000)]);

async function essai(seuil, silenceMs) {
  const res = {};
  let t0 = 0;
  const ws = await ouvrirGrok({
    instructions: "Tu es l'assistant téléphonique d'un distributeur de pompes. Réponds en une phrase courte.", voice: "leo", reasoning: { effort: "none" },
    turn_detection: { type: "server_vad", threshold: seuil, prefix_padding_ms: 300, silence_duration_ms: silenceMs },
    audio: { input: { format: { type: "audio/pcm", rate: 8000 } }, output: { format: { type: "audio/pcm", rate: 8000 } } },
  });
  await new Promise((ok) => {
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
  t0 = Date.now();
  for (let o = 0, k = 0; o < tout.length; o += 320, k++) {
    const attendre = t0 + k * 20 - Date.now();
    if (attendre > 0) await new Promise((r) => setTimeout(r, attendre));
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: tout.subarray(o, o + 320).toString("base64") }));
  }
  await new Promise((r) => setTimeout(r, 1500));
  ws.close();
  const ms = (x) => (x == null || Number.isNaN(x) ? "  -  " : String(Math.round(x)).padStart(5));
  console.log(`seuil ${seuil} silence ${String(silenceMs).padStart(4)} | debut ${ms(res.debut - PAROLE_DEBUT)} (recu ${ms(res.debutRecu - PAROLE_DEBUT)}) | fin ${ms(res.fin - PAROLE_FIN)} (recue ${ms(res.finRecue - PAROLE_FIN)}) | reponse creee ${ms(res.creee - PAROLE_FIN)} | premier son ${ms(res.son - PAROLE_FIN)} ms apres la vraie fin${res.erreur ? " | " + res.erreur : ""}`);
}

for (let i = 0; i < ESSAIS; i++) for (const [seuil, sil] of [[0.55, 600], [0.5, 400], [0.85, 600], [0.7, 500]]) {
  try { await essai(seuil, sil); } catch (err) { console.log(`seuil ${seuil} silence ${sil} : échec ${err.message}`); }
}
