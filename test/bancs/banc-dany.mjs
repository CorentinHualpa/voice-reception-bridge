// Banc d'appel LOCAL de Dany (Motralec) sur le systeme de Palazzo : cerveau OpenAI en texte, voix ElevenLabs,
// accueil pre-enregistre, demi-duplex. server.js tourne sur ce poste, ce script joue Twilio et un client de
// synthese (voix ElevenLabs « Marcel ») qui deroule une demande de devis : besoin, nom, email EPELE, ville, numero.
// Rien ne touche la ligne de production ni le recap (N8N_RECAP_URL absent).
// Sorties : journal du pont et enregistrement stereo (gauche agent, droite client) dans .sorties/.
// Usage : node test/bancs/banc-dany.mjs [nom]   (variables du pont surchargeables : ELEVEN_VOIX, ELEVEN_BALISE, CERVEAU...)
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { ulawDecodeSample } from "../../lib/audio.js";
const ICI = path.dirname(fileURLToPath(import.meta.url));
const RACINE = path.join(ICI, "../..");
const S = process.env.BANC_SORTIE || path.join(ICI, ".sorties");
fs.mkdirSync(S, { recursive: true });
const NOM = process.argv[2] || "banc-dany";
const PORT = 8891 + Math.floor(Math.random() * 100);
const vault = fs.readFileSync(process.env.VAULT || "C:/Users/msi/.secrets/api-keys.env", "utf8");
const cle = (n) => (vault.match(new RegExp(`^${n}=(.*)$`, "m"))?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
const ACCUEIL = "Bonjour, bienvenue chez Motralec. Je suis Dany. Notre standard est actuellement fermé, mais je peux prendre votre message pour qu'un conseiller vous rappelle. Vous appelez pour quel sujet ?";

// Repliques du client, synthetisees une fois (cache dans .sorties) par une autre voix qu'agent.
const REPLIQUES = (process.env.REPLIQUES ? JSON.parse(process.env.REPLIQUES) : [
  "Oui bonjour, j'ai une pompe de relevage dans mon sous-sol qui ne se déclenche plus, il me faudrait un devis pour la remplacer.",
  "Mohamed Lallouche.",
  "Alors c'est M, O, H, A, M, E, D, point, L, A, deux L, O, U, C, H, E, arobase gmail point com.",
  "Oui c'est ça.",
  "Argenteuil.",
  "Oui, ce numéro-là c'est parfait. Merci, au revoir.",
]);
const VOIX_CLIENT = process.env.VOIX_CLIENT || "kENkNtk0xyzG09WW40xE";
async function synthese(texte) {
  const f = path.join(S, `client-${Buffer.from(VOIX_CLIENT + texte).toString("base64url").slice(-40)}.ulaw`);
  if (fs.existsSync(f)) return fs.readFileSync(f);
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOIX_CLIENT}?output_format=ulaw_8000`, {
    method: "POST", headers: { "xi-api-key": cle("ELEVENLABS_API_KEY"), "content-type": "application/json" },
    body: JSON.stringify({ text: texte, model_id: "eleven_v4_turbo" }),
  });
  if (!r.ok) throw new Error(`synthese client ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(f, b);
  return b;
}
const MORCEAUX = [];
for (const t of REPLIQUES) MORCEAUX.push({ texte: t, buf: await synthese(t) });
// VOILA=1 : « Voilà. » 400 ms apres l'email epele, avant que sa transcription arrive (cas qui perdait la ligne).
const VOILA = process.env.VOILA === "1" ? { texte: "Voilà.", buf: await synthese("Voilà.") } : null;

const journal = [];
const envPont = {
  SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, PORT: String(PORT),
  XAI_API_KEY: cle("XAI_API_KEY"), OPENAI_API_KEY: cle("OPENAI_API_KEY"), ELEVENLABS_API_KEY: cle("ELEVENLABS_API_KEY"),
  RECEPTION_PROMPT: fs.readFileSync(path.join(RACINE, "prompt.motralec.txt"), "utf8"),
  AGENT_NAME: "Dany", BUSINESS_NAME: "Motralec", AGENT_LANG: "fr", GROK_VOICE: "leo", GROK_REASONING: "none", GROK_SPEED: "1.15", GROK_RATE: "8000",
  // Reglages cibles de Dany (ceux qui seront poses sur le service bridge).
  CERVEAU: "openai", OPENAI_REALTIME_MODEL: "gpt-realtime-1.5",
  LECTURE: "elevenlabs", ELEVEN_VOIX: "GRKzEhPHr0FFNDlaqQei", ELEVEN_MODELE: "eleven_v4_turbo",
  ELEVEN_BALISE: "[said warmly and courteously, at a natural pace]",
  ACCUEIL_TEXTE: ACCUEIL, ACCUEIL_JEU: "avec un ton chaleureux et posé", OPENAI_VOIX: "cedar", ELEVEN_DELAI_MAX_MS: "4000", HEDGE_APRES_MS: "0", FIN_DE_TOUR_MS: "1000", REDITE_ATTENTE_MS: "0", EVITER_FIN_SUR_QUESTION: "0",
  AMBIANCE: "centre-appels", JOURNAL_DIALOGUE: "1",
};
for (const k of Object.keys(envPont)) if (process.env[k] !== undefined && !/KEY/.test(k)) envPont[k] = process.env[k];
const pont = spawn(process.execPath, ["server.js"], { cwd: RACINE, env: envPont });
const t0 = Date.now();
const horo = () => `${((Date.now() - t0) / 1000).toFixed(2)}`.padStart(6);
for (const flux of [pont.stdout, pont.stderr]) flux.on("data", (d) => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) journal.push(`${horo()} ${l}`); });
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

let ws = null;
for (let i = 0; i < 40 && !ws; i++) {
  await attendre(250);
  try { ws = await new Promise((ok, ko) => { const w = new WebSocket(`ws://127.0.0.1:${PORT}/twilio`); w.onopen = () => ok(w); w.onerror = () => ko(new Error("pas encore")); }); } catch {}
}
if (!ws) { console.log("le pont ne répond pas"); console.log(journal.join("\n")); pont.kill(); process.exit(1); }

// ---- Twilio simule : file de lecture, marks, clear ----
const DUREE_MAX_S = 180;
const agent = new Int16Array(8000 * DUREE_MAX_S), client = new Int16Array(8000 * DUREE_MAX_S);
let debutFlux = 0, finLecture = 0, finParole = 0; // finParole : fin du dernier son de PAROLE (le fond sonore ne compte pas)
const marks = [];
const ecrits = [];
const ech = (ms) => Math.max(0, Math.round(((ms - debutFlux) / 1000) * 8000));
const agentParle = () => Date.now() < finParole;
let premierSonApres = null, dernierSonAgent = 0, sonsAgent = 0, premierSonAppel = null;
const latences = [];
const envoyer = (o) => ws.send(JSON.stringify(o));
ws.onmessage = (m) => {
  const e = JSON.parse(m.data);
  const maintenant = Date.now();
  if (e.event === "media") {
    const u = Buffer.from(e.media.payload, "base64");
    // Le fond sonore (ambiance) envoie du son en continu : seul un son au-dessus du bruit compte comme parole.
    let somme = 0; for (let i = 0; i < u.length; i++) { const s = ulawDecodeSample(u[i]); somme += s * s; }
    const parole = Math.sqrt(somme / u.length) > 600;
    const debut = Math.max(maintenant, finLecture);
    const i0 = ech(debut);
    for (let i = 0; i < u.length && i0 + i < agent.length; i++) agent[i0 + i] = ulawDecodeSample(u[i]);
    ecrits.push({ de: i0, a: i0 + u.length });
    if (parole && premierSonAppel === null) { premierSonAppel = debut - debutFlux; journal.push(`${horo()} [banc] premier son de l'accueil ${premierSonAppel} ms après le décroché`); }
    if (parole && premierSonApres) { const l = debut - premierSonApres; latences.push(l); journal.push(`${horo()} [banc] premier son de l'agent ${l} ms après la fin du client`); premierSonApres = null; }
    finLecture = debut + (u.length / 8000) * 1000;
    if (parole) { sonsAgent++; dernierSonAgent = finLecture; finParole = finLecture; }
  } else if (e.event === "mark") {
    marks.push({ nom: e.mark.name, a: Math.max(maintenant, finLecture) });
  } else if (e.event === "clear") {
    const iNow = ech(maintenant);
    for (const w of ecrits) for (let i = Math.max(w.de, iNow); i < w.a && i < agent.length; i++) agent[i] = 0;
    journal.push(`${horo()} [banc] Twilio vide la file`);
    finLecture = maintenant; dernierSonAgent = maintenant;
    for (const k of marks) k.a = maintenant;
  }
};
setInterval(() => {
  const maintenant = Date.now();
  for (let i = marks.length - 1; i >= 0; i--) if (marks[i].a <= maintenant) { envoyer({ event: "mark", streamSid: "MZbanc", mark: { name: marks[i].nom } }); marks.splice(i, 1); }
}, 20);

envoyer({ event: "connected" });
envoyer({ event: "start", start: { streamSid: "MZbanc", callSid: "CAbanc", customParameters: { from: "+33612345678", to: "+33939241266" } } });
debutFlux = Date.now();

let enCours = null, pos = 0, trame = 0, fini = false;
const jouer = (m) => new Promise((ok) => { enCours = { ...m, ok }; pos = 0; journal.push(`${horo()} [banc] client dit « ${m.texte} »`); });
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

await jusqua(silenceAgent(1200), 40000); // accueil fini
for (const m of MORCEAUX) {
  await jouer(m);
  if (VOILA && /arobase/.test(m.texte)) { await attendre(Number(process.env.VOILA_MS || 400)); await jouer(VOILA); }
  const n = sonsAgent;
  await jusqua(() => sonsAgent > n, 15000);
  await jusqua(silenceAgent(1500), 45000);
}
await attendre(4000);
fini = true;
envoyer({ event: "stop", streamSid: "MZbanc" });
await attendre(2000);
ws.close();
pont.kill();

// Enregistrement stereo et journal.
const n = Math.min(agent.length, Math.max(ech(Date.now()), 8000));
const pcm = Buffer.alloc(n * 4);
for (let i = 0; i < n; i++) { pcm.writeInt16LE(agent[i], i * 4); pcm.writeInt16LE(client[i], i * 4 + 2); }
fs.writeFileSync(`${S}/${NOM}.pcm`, pcm);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "s16le", "-ar", "8000", "-ac", "2", "-i", `${S}/${NOM}.pcm`, `${S}/${NOM}.wav`]);
fs.unlinkSync(`${S}/${NOM}.pcm`);
fs.writeFileSync(`${S}/${NOM}.log`, journal.join("\n"));
const tri = [...latences].sort((a, b) => a - b);
console.log(journal.filter((l) => /\[banc\]|\[lecture\] n°|\[session\]|\[cerveau\]|\[accueil\]|erreur|error|Error|\[dialogue\]|^\s*[\d.]+\s+(Client|Agent) :/.test(l)).map((l) => l.replace(/ sid=CA\w+/, "").slice(0, 260)).join("\n"));
console.log(`\nlatences (ms) : ${latences.join(", ")} | mediane ${tri[Math.floor(tri.length / 2)] ?? "-"} | accueil ${premierSonAppel} ms`);
console.log(`enregistrement : ${path.resolve(S, NOM + ".wav")}`);
process.exit(0);
