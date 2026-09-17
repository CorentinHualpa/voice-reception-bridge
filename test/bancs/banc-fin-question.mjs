// Grok avale-t-il la fin des phrases de l'agent quand elles finissent sur une question ? Mesuré sur Palazzo le
// 17/09/2026 (voix eve : 27 fins coupées sur 27). Ce banc rejoue la mesure avec l'agent des bancs (Dany, voix leo)
// et ses vraies phrases : chacune est dite mot pour mot, avec et sans quelques mots après la question.
// Une fin est « abrupte » quand l'énergie reste forte dans les 100 ms avant la fin de l'audio. Chaque audio est
// gardé dans .sorties pour l'écoute, et sa fin transcrite (OPENAI_API_KEY) pour voir si le dernier mot y est.
// Usage : node test/bancs/banc-fin-question.mjs [essais=5]
import fs from "node:fs";
import path from "node:path";
import { AGENT, SORTIES, attendre, cle, ouvrirGrok, wavMono8k } from "./config-banc.mjs";

const ESSAIS = Number(process.argv[2] || 5);
const rms = (b, d, f) => { let s = 0, n = 0; for (let i = Math.max(0, d); i + 1 < f; i += 2) { const v = b.readInt16LE(i); s += v * v; n++; } return n ? Math.round(Math.sqrt(s / n)) : 0; };

const CAS = {
  "accueil": AGENT.accueil,
  "accueil+ecoute": `${AGENT.accueil} Je vous écoute.`,
  "nom": "Je note. Pourriez-vous me donner votre prénom et votre nom, s'il vous plaît ?",
  "nom+ecoute": "Je note. Pourriez-vous me donner votre prénom et votre nom, s'il vous plaît ? Je vous écoute.",
  "email-confirm": "Je vous épelle pour vérifier : J, E, A, N, arobase gmail point com. C'est bien ça ?",
  "affirmation": "Toute l'équipe de Motralec vous remercie pour votre appel. Très bonne journée.",
};

async function transcrire(wav) {
  const k = cle("OPENAI_API_KEY");
  if (!k) return "";
  const fd = new FormData();
  fd.append("file", new Blob([wav], { type: "audio/wav" }), "fin.wav");
  fd.append("model", "gpt-4o-transcribe");
  fd.append("language", "fr");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${k}` }, body: fd });
  return r.ok ? (await r.json()).text : `(transcription ${r.status})`;
}

const ws = await ouvrirGrok({
  instructions: AGENT.instructions,
  voice: AGENT.voice, reasoning: { effort: AGENT.reasoning },
  audio: { input: { format: { type: "audio/pcm", rate: 8000 }, turn_detection: null }, output: { format: { type: "audio/pcm", rate: 8000 }, speed: AGENT.speed } },
});
let courant = [], fini = false;
await new Promise((ok) => {
  ws.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === "session.updated") ok();
    else if (e.type === "response.output_audio.delta") courant.push(Buffer.from(e.delta, "base64"));
    else if (e.type === "response.done") fini = true;
  };
});
const bilan = {};
for (let n = 1; n <= ESSAIS; n++) {
  for (const [nom, phrase] of Object.entries(CAS)) {
    courant = []; fini = false;
    ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "(SYSTÈME : phrase suivante.)" }] } }));
    ws.send(JSON.stringify({ type: "response.create", response: { instructions: `Dis exactement cette phrase, mot pour mot, sans rien ajouter avant ni après : « ${phrase} »` } }));
    for (let k = 0; k < 200 && !fini; k++) await attendre(100);
    const p = Buffer.concat(courant); const pcm = p.subarray(0, p.length - (p.length % 2)); const L = pcm.length;
    const avant = rms(pcm, L - 1600, L - 160);
    const fichier = path.join(SORTIES, `fin-${nom}-${n}.wav`);
    fs.writeFileSync(fichier, wavMono8k(pcm));
    // Les 2,5 dernières secondes suffisent à lire le dernier mot.
    const fin = await transcrire(wavMono8k(pcm.subarray(Math.max(0, L - 40000))));
    (bilan[nom] ??= []).push({ s: (L / 16000).toFixed(2), avant, abrupt: avant > 600, fin });
  }
}
ws.close();
for (const [nom, l] of Object.entries(bilan)) {
  console.log(`${nom.padEnd(15)} abruptes ${l.filter((x) => x.abrupt).length}/${l.length}  ${l.map((x) => `${x.s}s:${x.avant}${x.abrupt ? "!" : ""}`).join("  ")}`);
  for (const x of l) console.log(`${"".padEnd(17)}… ${x.fin.slice(-70)}`);
}
