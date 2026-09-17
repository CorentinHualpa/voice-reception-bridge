// Grok arrête-t-il la réponse qu'il génère quand il entend le client ? Trois sessions neuves, même demande en
// mode manuel : A sans bruit (témoin), B avec un « Mmm » envoyé en direct pendant la génération, C avec le même
// « Mmm » retenu puis envoyé d'un bloc après response.done (ce que fait le pont en TOURS=pont).
// Usage : node test/bancs/banc-manuel-tampon.mjs
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, attendre, ouvrirGrok } from "./config-banc.mjs";

const wav = (nom) => fs.readFileSync(path.join(FIXTURES, `client-${nom}.wav`)).subarray(44);
const question = Buffer.concat([wav("besoin"), Buffer.alloc(8000)]);
const mmm = Buffer.concat([wav("mmm"), Buffer.alloc(4000)]);

async function session(mode) {
  const r = { audioMs: 0, texte: "", statut: null, reponses: 0 };
  let actif = false;
  const ws = await ouvrirGrok({
    instructions: "Tu es l'assistant téléphonique d'un distributeur de pompes. À une demande de devis de pompe de relevage, tu présentes d'abord les quatre familles en détail, une phrase chacune : pompes pour eaux claires, pompes pour eaux chargées, pompes dilacératrices, stations de relevage complètes. Puis tu demandes le nom du client.",
    voice: "leo", reasoning: { effort: "none" }, turn_detection: {},
    audio: { input: { format: { type: "audio/pcm", rate: 8000 } }, output: { format: { type: "audio/pcm", rate: 8000 } } },
  });
  await new Promise((ok) => {
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
  const jouer = async (buf) => { const d = Date.now(); for (let o = 0, k = 0; o < buf.length; o += 320, k++) { const w = d + k * 20 - Date.now(); if (w > 0) await attendre(w); ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: buf.subarray(o, o + 320).toString("base64") })); } };
  await jouer(question);
  ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  ws.send(JSON.stringify({ type: "response.create" }));
  for (let i = 0; i < 40 && !actif; i++) await attendre(50);
  await attendre(400);
  if (mode === "direct") await jouer(mmm);
  else if (mode === "retenu") { await attendre(mmm.length / 16); for (let i = 0; i < 80 && actif; i++) await attendre(100); ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: mmm.toString("base64") })); ws.send(JSON.stringify({ type: "input_audio_buffer.clear" })); }
  for (let i = 0; i < 80 && actif; i++) await attendre(100);
  await attendre(1500);
  ws.close();
  console.log(`${mode.padEnd(7)} statut=${r.statut} audio=${(r.audioMs / 1000).toFixed(1)}s réponses=${r.reponses}${r.erreur ? " ERREUR " + r.erreur : ""}\n        « ${r.texte.slice(0, 220)} »`);
}

for (const mode of ["temoin", "direct", "retenu"]) await session(mode);
