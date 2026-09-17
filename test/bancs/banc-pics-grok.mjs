// D'où viennent les pics de Grok (premier son à ~3,6 s une réponse sur cinq en appel réel, jamais sur une consigne
// courte avec une question écrite) ? Quatre variantes en parallèle, un seul facteur changé à la fois :
//   court-texte    consigne d'une ligne, question écrite, aucun outil
//   long-texte     consigne complète de Palazzo + carte + outils de commande, question écrite
//   court-audio    consigne d'une ligne, question dite (voix du client validée par commit), aucun outil
//   long-audio     consigne complète + carte + outils, question dite : les conditions d'un appel
// Mesure : premier son après response.create, et ce qui l'a précédé (transcription, création).
// Usage : node test/bancs/banc-pics-grok.mjs [N=20] [variantes séparées par des virgules]
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createPizzeria } from "../../lib/pizzeria.js";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(ICI, "fixtures");
const vault = fs.readFileSync(process.env.VAULT || "C:/Users/msi/.secrets/api-keys.env", "utf8");
const CLE = (vault.match(/^XAI_API_KEY=(.*)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
const N = Number(process.argv[2] || 20);
const VARIANTES = (process.argv[3] || "court-texte,long-texte,court-audio,long-audio").split(",");
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

const session = JSON.parse(fs.readFileSync(path.join(FIXTURES, "session-palazzo.json"), "utf8"));
const pizzeria = createPizzeria({ menuFile: path.join(ICI, "../../menus/palazzo.json"), dataFile: "", capaciteParQuart: 15, reserveParQuart: 0, delaiMinMinutes: 20, maxPizzas: 20, services: "11:30-14:30,18:30-22:30", timeZone: "Europe/Paris", distant: null });
const LONGUE = `${session.instructions}\n\n# Contexte de cet appel\n${pizzeria.contexteAppel()}\nLa carte complète et à jour, avec les prix, est ci-dessous.\n\n${pizzeria.carteTexte()}`;
const OUTILS = [...pizzeria.tools, ...(session.tools || [])];
const COURTE = "Tu es Chiara, au téléphone chez Palazzo Pizza, à Saint-Jean-de-Védas. Réponses très courtes, une phrase.";
const extrait = (a, b) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(a), "-to", String(b), "-i", path.join(FIXTURES, "client-polly.wav"), "-f", "s16le", "-ac", "1", "-ar", "8000", "-"], { maxBuffer: 64 * 1024 * 1024 });
const QUESTIONS = [
  { texte: "Bonjour, qu'est-ce que vous avez comme pizza avec du jambon ?", audio: extrait(15.0, 18.7) },
  { texte: "Attendez, en fait, est-ce que vous faites des pizzas sans gluten ?", audio: extrait(25.0, 29.3) },
  { texte: "D'accord, je prends la Rucola.", audio: extrait(40.9, 43.4) },
];
console.log(`consigne longue : ${LONGUE.length} caractères, ${OUTILS.length} outils`);

async function variante(nom) {
  const longue = nom.startsWith("long"), audio = nom.endsWith("audio");
  const tok = await fetch("https://api.x.ai/v1/realtime/client_secrets", { method: "POST", headers: { Authorization: `Bearer ${CLE}`, "Content-Type": "application/json" }, body: JSON.stringify({ expires_after: { seconds: 900 } }) }).then((r) => r.json());
  const ws = new WebSocket("wss://api.x.ai/v1/realtime?model=grok-voice-latest", [`xai-client-secret.${tok.value || tok.client_secret?.value}`]);
  await new Promise((ok) => { ws.onopen = ok; });
  const evts = [];
  ws.onmessage = (m) => { const e = JSON.parse(m.data); e._a = Date.now(); evts.push(e); };
  ws.send(JSON.stringify({ type: "session.update", session: {
    instructions: longue ? LONGUE : COURTE,
    ...(longue ? { tools: OUTILS, tool_choice: "auto" } : {}),
    voice: "carina", reasoning: { effort: "none" },
    audio: { input: { format: { type: "audio/pcm", rate: 8000 }, transcription: { model: "grok-transcribe", language_hint: "fr" }, turn_detection: null }, output: { format: { type: "audio/pcm", rate: 8000 }, speed: 1.1 } },
  } }));
  for (let i = 0; i < 80 && !evts.some((e) => e.type === "session.updated"); i++) await attendre(100);
  const lignes = [];
  for (let i = 0; i < N; i++) {
    const q = QUESTIONS[i % QUESTIONS.length];
    const avant = evts.length;
    let d;
    if (audio) {
      for (let o = 0; o < q.audio.length; o += 320) ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: q.audio.subarray(o, o + 320).toString("base64") }));
      ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    } else {
      ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: q.texte }] } }));
    }
    d = Date.now();
    ws.send(JSON.stringify({ type: "response.create" }));
    let fin = null;
    for (let k = 0; k < 400 && !fin; k++) { await attendre(25); fin = evts.slice(avant).find((e) => e.type === "response.done"); }
    const ev = evts.slice(avant);
    const t = (type) => { const e = ev.find((x) => x.type === type); return e ? e._a - d : null; };
    const outils = ev.filter((e) => e.type === "response.function_call_arguments.done").map((e) => e.name);
    lignes.push({ son: t("response.output_audio.delta"), cree: t("response.created"), transcrit: t("conversation.item.input_audio_transcription.completed"), texte1: t("response.output_audio_transcript.delta"), outils });
    // Une réponse qui appelle un outil reçoit un résultat neutre, pour garder la conversation valide.
    for (const e of ev.filter((x) => x.type === "response.function_call_arguments.done")) ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: e.call_id, output: JSON.stringify({ ok: true }) } }));
    await attendre(400);
  }
  ws.close();
  const sons = lignes.map((l) => l.son).filter((x) => x != null).sort((a, b) => a - b);
  const pics = lignes.filter((l) => l.son != null && l.son >= 2000);
  console.log(`\n${nom.padEnd(12)} médiane ${sons[sons.length >> 1]} ms, ${pics.length}/${sons.length} au-delà de 2 s, ${lignes.filter((l) => l.son == null).length} sans son`);
  console.log(`  premiers sons : ${lignes.map((l) => (l.son ?? "-") + (l.outils.length ? "*" : "")).join(" ")}   (* = outil appelé)`);
  for (const p of pics) console.log(`  pic ${p.son} ms : créée +${p.cree}, transcription +${p.transcrit}, premier texte +${p.texte1}, outils ${p.outils.join(",") || "aucun"}`);
}
await Promise.all(VARIANTES.map((v) => variante(v)));
process.exit(0);
