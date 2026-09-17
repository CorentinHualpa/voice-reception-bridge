// Banc d'appel LOCAL du pont : server.js tourne sur ce poste contre la vraie API de Grok, et ce script joue
// Twilio (Media Streams) avec un client qui réagit à l'agent : question après l'accueil, « Mmm » pendant la
// réponse, interruption, puis choix d'une pizza. Rien ne touche la ligne de production.
// Sorties : journal du pont, enregistrement stéréo (gauche agent tel qu'il est joué, droite client).
// Usage : node banc-appel-local.mjs [pont|grok] [nom]
import path from "node:path";
import { fileURLToPath } from "node:url";
const ICI = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(ICI, "fixtures");
import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { ulawDecodeSample, ulawEncodeSample } from "../../lib/audio.js";

const S = process.env.BANC_SORTIE || path.join(ICI, ".sorties");
fs.mkdirSync(S, { recursive: true });
const MODE = process.argv[2] || "pont";
const NOM = process.argv[3] || `banc-local-${MODE}`;
const PORT = 8791 + Math.floor(Math.random() * 100);
const vault = fs.readFileSync(process.env.VAULT || "C:/Users/msi/.secrets/api-keys.env", "utf8");
const CLE = (vault.match(/^XAI_API_KEY=(.*)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
const session = JSON.parse(fs.readFileSync(`${process.env.BANC_SESSION || path.join(FIXTURES, "session-palazzo.json")}`, "utf8"));

// Morceaux de la voie client de l'appel de test, en mu-law 8 kHz.
const pcmDe = (a, b) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(a), "-to", String(b), "-i", `${path.join(FIXTURES, "client-polly.wav")}`, "-f", "s16le", "-ac", "1", "-ar", "8000", "-"], { maxBuffer: 64 * 1024 * 1024 });
const enUlaw = (pcm) => { const o = Buffer.alloc(pcm.length >> 1); for (let i = 0; i < o.length; i++) o[i] = ulawEncodeSample(pcm.readInt16LE(i * 2)); return o; };
const MORCEAUX = {
  question: enUlaw(pcmDe(15.1, 18.5)),
  mmm: enUlaw(pcmDe(22.36, 23.18)),
  attendez: enUlaw(pcmDe(25.12, 29.12)),
  rucola: enUlaw(pcmDe(41.02, 43.22)),
  // Bruit blanc de 0,6 s au-dessus du seuil de voix, sans aucun mot : Grok n'en fait pas de message.
  bruit: (() => { const p = Buffer.alloc(9600); for (let i = 0; i < 4800; i++) p.writeInt16LE(Math.round((Math.random() * 2 - 1) * 4000), i * 2); return enUlaw(p); })(),
};
// SCENARIO=anticipation : « Attendez, en fait… (pause de 460 ms) …est-ce que vous faites des pizzas sans gluten ? »
// dit quand l'agent se tait (l'anticipation part dans la pause puis s'annule), un bruit sans mot, puis la question.
const SCENARIO = process.env.SCENARIO || "complet";
// SCENARIO=lorenzo : « je voudrais parler à Lorenzo », « Marc », puis « non merci, au revoir » (voix rex de Grok TTS,
// produite au lancement). Sert aux gardes de fin d'appel : pas de raccrochage juste après transmettre_message, pas de
// relance après un end_call dont l'au revoir est déjà dit.
if (SCENARIO === "lorenzo") {
  const dire = async (texte) => {
    const r = await fetch("https://api.x.ai/v1/tts", { method: "POST", headers: { authorization: `Bearer ${CLE}`, "content-type": "application/json" }, body: JSON.stringify({ text: texte, voice_id: "rex", language: "fr", output_format: { codec: "mulaw", sample_rate: 8000 } }) });
    return Buffer.from(await r.arrayBuffer());
  };
  MORCEAUX.lorenzo = await dire("Bonjour, je voudrais parler à Lorenzo, c'est pour une commande de groupe samedi.");
  MORCEAUX.marc = await dire("Marc.");
  MORCEAUX.aurevoir = await dire("Non merci, ce sera tout. Au revoir.");
}

const journal = [];
const pont = spawn(process.execPath, ["server.js"], {
  cwd: path.join(ICI, "../.."),
  env: {
    SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, PORT: String(PORT), XAI_API_KEY: CLE,
    RECEPTION_PROMPT: session.instructions, AGENT_TOOLS: "pizzeria", MENU_FILE: "menus/palazzo.json",
    BARGE_IN: "1", GROK_VOICE: session.voice || "eve", GROK_REASONING: "none", GROK_SPEED: String(session.speed || 1), TOURS: MODE,
    // Comme Palazzo en production : 900 ms d'attente de fin de phrase (silenceMs de l'agent). ANTICIPATION_MS=0 pour comparer.
    FIN_DE_TOUR_MS: process.env.FIN_DE_TOUR_MS || String(session.silenceMs || 900), ANTICIPATION_MS: process.env.ANTICIPATION_MS ?? "400", JOURNAL_DIALOGUE: "1",
    MMM_APRES_MS: process.env.MMM_APRES_MS ?? "2400", // un seuil bas (700) force le « Mmm » d'attente pour l'entendre
    // Parades aux pics de Grok (17/09). HEDGE_APRES_MS=300 fait doubler CHAQUE tour, pour voir la doublure a
    // l'oeuvre sans attendre un vrai blocage ; AMBIANCE_APRES_MS=600 remplit tous les blancs, pour l'entendre.
    ...(process.env.HEDGE_APRES_MS ? { HEDGE_APRES_MS: process.env.HEDGE_APRES_MS } : {}),
    ...(process.env.AMBIANCE_APRES_MS ? { AMBIANCE_APRES_MS: process.env.AMBIANCE_APRES_MS } : {}),
    ...(process.env.AMBIANCE_GAIN ? { AMBIANCE_GAIN: process.env.AMBIANCE_GAIN } : {}),
    ...(process.env.AMBIANCE_FICHIER ? { AMBIANCE_FICHIER: process.env.AMBIANCE_FICHIER } : {}),
  },
});
const t0 = Date.now();
const horo = () => `${((Date.now() - t0) / 1000).toFixed(2)}`.padStart(6);
for (const flux of [pont.stdout, pont.stderr]) flux.on("data", (d) => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) journal.push(`${horo()} ${l}`); });
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

let ws = null;
for (let i = 0; i < 40 && !ws; i++) {
  await attendre(250);
  try { ws = await new Promise((ok, ko) => { const w = new WebSocket(`ws://127.0.0.1:${PORT}/twilio`); w.onopen = () => ok(w); w.onerror = () => ko(new Error("pas encore")); }); } catch {}
}
if (!ws) { console.log("le pont ne répond pas"); pont.kill(); process.exit(1); }

// ---- Twilio simulé : file de lecture, marks, clear ----
const DUREE_MAX_S = 110;
const agent = new Int16Array(8000 * DUREE_MAX_S), client = new Int16Array(8000 * DUREE_MAX_S);
let debutFlux = 0, finLecture = 0; // ms murales
const marks = []; // { nom, a }
const ecrits = []; // { de, a } échantillons de l'agent planifiés
const ech = (ms) => Math.max(0, Math.round(((ms - debutFlux) / 1000) * 8000));
const agentParle = () => Date.now() < finLecture;
let premierSonApres = null, dernierSonAgent = 0, sonsAgent = 0;
const envoyer = (o) => ws.send(JSON.stringify(o));
ws.onmessage = (m) => {
  const e = JSON.parse(m.data);
  const maintenant = Date.now();
  if (e.event === "media") {
    const u = Buffer.from(e.media.payload, "base64");
    const debut = Math.max(maintenant, finLecture);
    const i0 = ech(debut);
    for (let i = 0; i < u.length && i0 + i < agent.length; i++) agent[i0 + i] = ulawDecodeSample(u[i]);
    ecrits.push({ de: i0, a: i0 + u.length });
    if (!agentParle() && premierSonApres) { journal.push(`${horo()} [banc] premier son de l'agent ${debut - premierSonApres} ms après la fin du client`); premierSonApres = null; }
    finLecture = debut + (u.length / 8000) * 1000;
    sonsAgent++;
    dernierSonAgent = finLecture;
  } else if (e.event === "mark") {
    marks.push({ nom: e.mark.name, a: Math.max(maintenant, finLecture) });
  } else if (e.event === "clear") {
    const iNow = ech(maintenant);
    for (const w of ecrits) for (let i = Math.max(w.de, iNow); i < w.a && i < agent.length; i++) agent[i] = 0;
    journal.push(`${horo()} [banc] Twilio vide la file (${((finLecture - maintenant) / 1000).toFixed(1)} s d'agent jetées)`);
    finLecture = maintenant;
    dernierSonAgent = maintenant;
    for (const k of marks) k.a = maintenant;
  }
};
setInterval(() => {
  const maintenant = Date.now();
  for (let i = marks.length - 1; i >= 0; i--) if (marks[i].a <= maintenant) { envoyer({ event: "mark", streamSid: "MZbanc", mark: { name: marks[i].nom } }); marks.splice(i, 1); }
}, 20);

envoyer({ event: "connected" });
envoyer({ event: "start", start: { streamSid: "MZbanc", callSid: "CAbanc", customParameters: { from: "+33612345678", to: "+33900000000" } } });
debutFlux = Date.now();

// ---- Client simulé : 20 ms de mu-law à chaque pas, silence ou morceau en cours ----
let enCours = null, pos = 0, trame = 0, fini = false;
const jouer = (nom) => new Promise((ok) => { enCours = { nom, buf: MORCEAUX[nom], ok }; pos = 0; journal.push(`${horo()} [banc] client dit « ${nom} »${agentParle() ? " pendant que l'agent parle" : ""}`); });
(async () => {
  while (!fini) {
    const due = Math.floor((Date.now() - debutFlux) / 20);
    while (trame <= due) {
      const f = Buffer.alloc(160, 0xff);
      if (enCours) {
        enCours.buf.copy(f, 0, pos, Math.min(pos + 160, enCours.buf.length));
        pos += 160;
        if (pos >= enCours.buf.length) { const k = enCours; enCours = null; premierSonApres = Date.now(); k.ok(); }
      }
      const i0 = trame * 160;
      for (let i = 0; i < 160 && i0 + i < client.length; i++) client[i0 + i] = f[i] === 0xff ? 0 : ulawDecodeSample(f[i]);
      envoyer({ event: "media", streamSid: "MZbanc", media: { payload: f.toString("base64") } });
      trame++;
    }
    await attendre(10);
  }
})();

const jusqua = async (cond, maxMs) => { const d = Date.now(); while (!cond() && Date.now() - d < maxMs) await attendre(50); };
const silenceAgent = (ms) => () => sonsAgent > 0 && !agentParle() && Date.now() - dernierSonAgent > ms;

// Scénario
await jusqua(silenceAgent(1000), 30000);                 // accueil fini
if (SCENARIO === "lorenzo") {
  for (const nom of ["lorenzo", "marc", "aurevoir"]) {
    await jouer(nom);
    const n = sonsAgent;
    await jusqua(() => sonsAgent > n, 15000);
    await jusqua(silenceAgent(1500), 40000);
  }
  await attendre(4000);
  fini = true;
  envoyer({ event: "stop", streamSid: "MZbanc" });
  await attendre(1500);
  ws.close();
  pont.kill();
  fs.writeFileSync(`${S}/${NOM}.log`, journal.join("\n"));
  const iDialogue = journal.findIndex((l) => /\[dialogue\]/.test(l));
  console.log(journal.filter((l, i) => /\[banc\]|\[tour\] client|\[latence\]|\[outil\]|\[garde\]|hangup|erreur/.test(l) || (iDialogue >= 0 && i > iDialogue)).map((l) => l.replace(/ sid=CA\w+/, "").slice(0, 230)).join("\n"));
  process.exit(0);
}
if (SCENARIO === "anticipation") {
  await jouer("attendez");
  let n = sonsAgent;
  await jusqua(() => sonsAgent > n, 15000);
  await jusqua(silenceAgent(1500), 40000);
  await jouer("bruit");
  await attendre(3500);                                  // rien ne doit partir, et la voix doit rester libre
  await jouer("question");
  n = sonsAgent;
  await jusqua(() => sonsAgent > n, 15000);
  await jusqua(silenceAgent(2000), 40000);
  await attendre(500);
  fini = true;
  envoyer({ event: "stop", streamSid: "MZbanc" });
  await attendre(1500);
  ws.close();
  pont.kill();
  fs.writeFileSync(`${S}/${NOM}.log`, journal.join("\n"));
  const iDialogue = journal.findIndex((l) => /\[dialogue\]/.test(l));
  console.log(journal.filter((l, i) => /\[banc\]|\[tour\]|\[latence\]|\[reponse\]|coupe|erreur|\[son\]|jamais|deleted|cancel/.test(l) || (iDialogue >= 0 && i > iDialogue)).map((l) => l.replace(/ sid=CA\w+/, "").slice(0, 230)).join("\n"));
  process.exit(0);
}
await jouer("question");
const sonsAvant = sonsAgent;
await jusqua(() => sonsAgent > sonsAvant, 15000);        // l'agent commence sa réponse
await attendre(1500);
await jouer("mmm");                                      // bref, pendant la réponse
await attendre(1200);
await jouer("attendez");                                 // vraie interruption si l'agent parle encore
let avant = sonsAgent;
await jusqua(() => sonsAgent > avant, 15000);            // l'agent répond à l'interruption
await attendre(2500);
await jouer("mmm");                                      // bref, la génération est sans doute finie : effacé chez Grok
await jusqua(silenceAgent(1500), 40000);
await jouer("rucola");
avant = sonsAgent;
await jusqua(() => sonsAgent > avant, 15000);
await jusqua(silenceAgent(2000), 40000);
await attendre(500);
fini = true;
envoyer({ event: "stop", streamSid: "MZbanc" });
await attendre(1500);
ws.close();
pont.kill();

// Enregistrement stéréo : gauche agent, droite client
const n = Math.min(agent.length, Math.ceil(((Date.now() - debutFlux) / 1000) * 8000));
const data = Buffer.alloc(n * 4);
for (let i = 0; i < n; i++) { data.writeInt16LE(agent[i], i * 4); data.writeInt16LE(client[i], i * 4 + 2); }
const h = Buffer.alloc(44);
h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16);
h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000 * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
h.write("data", 36); h.writeUInt32LE(data.length, 40);
fs.writeFileSync(`${S}/${NOM}.wav`, Buffer.concat([h, data]));
fs.writeFileSync(`${S}/${NOM}.log`, journal.join("\n"));
console.log(journal.filter((l) => /\[banc\]|\[tour\]|\[latence\]|\[reponse\]|coupe|erreur|\[session\]|\[son\]|\[doublure\]|\[ambiance\]|jamais/.test(l)).map((l) => l.replace(/ sid=CA\w+/, "").slice(0, 230)).join("\n"));
process.exit(0);
