// Fins coupées en CONVERSATION (pas en « mot pour mot ») : la consigne de Chiara, un client qui commande en cinq
// répliques écrites, trois dialogues par variante, en parallèle :
//   actuel   consigne telle quelle (espaces français avant « ? » et « ! »)
//   colle    espaces avant ? ! ; : retirés de tout ce qui est envoyé à Grok, et consigne d'écrire « ? » collé
// Chaque réponse : dernier caractère de la transcription de Grok (une fin avalée perd son « ? ») et transcription
// indépendante des 700 dernières ms d'audio.
// Usage : node test/bancs/banc-fin-coupee-dialogue.mjs [dialogues=3] [variantes=actuel,colle]
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { createPizzeria } from "../../lib/pizzeria.js";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const S = path.join(ICI, ".sorties", "fin-coupee-dialogue");
fs.mkdirSync(S, { recursive: true });
const vault = fs.readFileSync(process.env.VAULT || "C:/Users/msi/.secrets/api-keys.env", "utf8");
const cle = (n) => (vault.match(new RegExp(`^${n}=(.*)$`, "m"))?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
const N = Number(process.argv[2] || 3);
const VARIANTES = (process.argv[3] || "actuel,colle").split(",");
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const session = JSON.parse(fs.readFileSync(path.join(ICI, "fixtures", "session-palazzo.json"), "utf8"));
const pizzeria = createPizzeria({ menuFile: path.join(ICI, "../../menus/palazzo.json") });
const CONSIGNE_QUESTION = "Au téléphone, ta voix avale la fin d'une réponse qui se termine sur une question. Ne finis donc jamais sur le point d'interrogation : après ta question, ajoute toujours deux ou trois mots, variés d'une fois sur l'autre (« Je vous écoute. », « Dites-moi. », « Prenez votre temps. »).";
const CONSIGNE_COLLE = "Écriture de tes réponses : le point d'interrogation et le point d'exclamation se collent au mot qui précède, SANS espace avant (« C'est pour quel prénom? », « Parfait! »), jamais « prénom ? ».";
const coller = (s) => s.replace(/[ \u00a0\u202f]+([?!;:])/g, "$1");
const CLIENT = ["Bonjour, je voudrais commander une pizza.", "Une Regina.", "Non merci, juste la pizza.", "Pour dix-neuf heures trente.", "Julien.", "Oui, c'est bien ça."];

async function transcrire(fichier) {
  const fd = new FormData();
  fd.append("file", new Blob([fs.readFileSync(fichier)], { type: "audio/wav" }), "r.wav");
  fd.append("model", "gpt-4o-transcribe");
  fd.append("language", "fr");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${cle("OPENAI_API_KEY")}` }, body: fd });
  return r.ok ? ((await r.json()).text || "").trim() : `(erreur ${r.status})`;
}
const wav = (pcm) => { const h = Buffer.alloc(44); h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]); };

async function dialogue(variante, n) {
  const colle = variante === "colle";
  const base = `${session.instructions}\n\n# Contexte de cet appel\n${pizzeria.contexteAppel()}\nLa carte complète et à jour, avec les prix, est ci-dessous.\n\n${pizzeria.carteTexte()}\n${CONSIGNE_QUESTION}${colle ? `\n${CONSIGNE_COLLE}` : ""}`;
  const tok = await fetch("https://api.x.ai/v1/realtime/client_secrets", { method: "POST", headers: { Authorization: `Bearer ${cle("XAI_API_KEY")}`, "Content-Type": "application/json" }, body: JSON.stringify({ expires_after: { seconds: 900 } }) }).then((r) => r.json());
  const ws = new WebSocket("wss://api.x.ai/v1/realtime?model=grok-voice-latest", [`xai-client-secret.${tok.value || tok.client_secret?.value}`]);
  await new Promise((ok) => { ws.onopen = ok; });
  let evts = [];
  ws.onmessage = (m) => { const e = JSON.parse(m.data); e._a = Date.now(); evts.push(e); };
  ws.send(JSON.stringify({ type: "session.update", session: {
    instructions: colle ? coller(base) : base, voice: session.voice || "carina", reasoning: { effort: "none" },
    audio: { input: { format: { type: "audio/pcm", rate: 8000 }, turn_detection: null }, output: { format: { type: "audio/pcm", rate: 8000 }, speed: 1.1 } },
  } }));
  for (let i = 0; i < 80 && !evts.some((e) => e.type === "session.updated"); i++) await attendre(100);
  const lignes = [];
  for (const [i, dit] of CLIENT.entries()) {
    evts = [];
    ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: dit }] } }));
    ws.send(JSON.stringify({ type: "response.create" }));
    for (let k = 0; k < 400 && !evts.some((e) => e.type === "response.done"); k++) await attendre(25);
    const texte = evts.filter((e) => e.type === "response.output_audio_transcript.delta").map((e) => e.delta || "").join("").trim();
    const pcmTout = Buffer.concat(evts.filter((e) => e.type === "response.output_audio.delta").map((e) => Buffer.from(e.delta, "base64")));
    const pcm = pcmTout.subarray(0, pcmTout.length - (pcmTout.length % 2));
    const fin = pcm.subarray(Math.max(0, pcm.length - 11200)); // 700 dernières ms
    const fichier = path.join(S, `${variante}-${n}-${i + 1}.wav`);
    fs.writeFileSync(fichier, wav(fin));
    // Un appel d'outil éventuel reçoit un résultat neutre pour que la conversation reste valide.
    for (const e of evts.filter((x) => x.type === "response.function_call_arguments.done")) ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: e.call_id, output: JSON.stringify({ ok: true }) } }));
    if (texte) lignes.push({ variante, n, i, texte, fichier, avalee: !/[.?!…»"]\s*$/.test(texte), question: /\?/.test(texte.slice(-60)) || !/[.!…»"]\s*$/.test(texte) });
    await attendre(300);
  }
  ws.close();
  await Promise.all(lignes.map(async (l) => { l.finEntendue = await transcrire(l.fichier); }));
  return lignes;
}

const toutes = (await Promise.all(VARIANTES.flatMap((v) => Array.from({ length: N }, (_, n) => dialogue(v, n + 1))))).flat();
for (const v of VARIANTES) {
  const ls = toutes.filter((l) => l.variante === v);
  const avalees = ls.filter((l) => l.avalee);
  const finQuestion = ls.filter((l) => /\?\s*$/.test(l.texte) || l.avalee).length;
  const espaceAvant = ls.filter((l) => /[ \u00a0\u202f][?!]/.test(l.texte)).length;
  console.log(`\n=== ${v} : ${ls.length} réponses, ${avalees.length} fins avalées (transcription sans ponctuation finale), ${finQuestion} finissent sur une question, ${espaceAvant} écrivent une espace avant ? ou !`);
  for (const l of avalees) console.log(`   avalée d${l.n} r${l.i + 1} : « …${l.texte.slice(-60)} » / fin entendue « ${l.finEntendue.slice(-40)} »`);
  for (const l of ls.filter((x) => !x.avalee).slice(0, 4)) console.log(`   ok     d${l.n} r${l.i + 1} : « …${l.texte.slice(-50)} »`);
}
process.exit(0);
