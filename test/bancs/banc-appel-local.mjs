// Banc d'appel LOCAL du pont : server.js tourne sur ce poste contre la vraie API de Grok, et ce script joue
// Twilio (Media Streams) avec un client qui réagit à l'agent. Rien ne touche la ligne de production, et aucun
// récap ne part : N8N_RECAP_URL n'est pas passé au pont.
// Scénario (demande de devis chez Motralec) : besoin, « Mmm » pendant la réponse, nom dit avec une pause au milieu,
// email, « Oui oui, c'est ça » dit PAR-DESSUS l'agent pendant qu'il épelle, confirmation, ville, confirmation du
// numéro, au revoir. BANC_ECHO=0.3 renvoie en plus la voix de l'agent dans la voie client (haut-parleur).
// Sorties : journal du pont, dialogue tel qu'il partirait en récap, enregistrement stéréo (gauche agent, droite client).
// Usage : node test/bancs/banc-appel-local.mjs [pont|grok] [nom]
//         BANC_SERVEUR=<dossier> joue un autre server.js (par exemple la version d'avant, pour comparer).
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { ulawDecodeSample, ulawEncodeSample } from "../../lib/audio.js";
import { AGENT, FIXTURES, RACINE, SORTIES, attendre, cle } from "./config-banc.mjs";

const MODE = process.argv[2] || "pont";
const NOM = process.argv[3] || `banc-local-${MODE}`;
const PORT = 8791 + Math.floor(Math.random() * 100);
const ECHO = Number(process.env.BANC_ECHO || 0);
const ECHO_RETARD = 960; // 120 ms à 8 kHz

if (!fs.existsSync(path.join(FIXTURES, "client-besoin.wav"))) execFileSync(process.execPath, [path.join(path.dirname(FIXTURES), "fabriquer-client.mjs")], { stdio: "inherit" });
const lireWav = (nom) => fs.readFileSync(path.join(FIXTURES, `client-${nom}.wav`)).subarray(44);
const enUlaw = (pcm) => { const o = Buffer.alloc(pcm.length >> 1); for (let i = 0; i < o.length; i++) o[i] = ulawEncodeSample(pcm.readInt16LE(i * 2)); return o; };
const MORCEAUX = Object.fromEntries(["besoin", "mmm", "nom-pause", "email", "par-dessus", "confirmer", "ville", "au-revoir"].map((n) => [n, lireWav(n)]));

const journal = [];
const pont = spawn(process.execPath, ["server.js"], {
  cwd: process.env.BANC_SERVEUR || RACINE,
  env: {
    SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, PORT: String(PORT), XAI_API_KEY: cle("XAI_API_KEY"), ADMIN_KEY: "banc",
    RECEPTION_PROMPT: AGENT.instructions, AGENT_NAME: "Dany", BUSINESS_NAME: "Motralec", AGENT_LANG: "fr",
    GROK_VOICE: AGENT.voice, GROK_REASONING: AGENT.reasoning, GROK_SPEED: String(AGENT.speed), GROK_VAD_THRESHOLD: "0.55", GROK_RATE: "8000",
    TOURS: MODE, ...(process.env.BARGE_IN ? { BARGE_IN: process.env.BARGE_IN } : {}), ...(process.env.FIN_DE_TOUR_MS ? { FIN_DE_TOUR_MS: process.env.FIN_DE_TOUR_MS } : {}),
    // Réponse anticipée et « Mmm » d'attente (portés de palazzo-v1) : ANTICIPATION_MS=0 MMM_APRES_MS=0 pour l'ancien pont.
    ...(process.env.ANTICIPATION_MS ? { ANTICIPATION_MS: process.env.ANTICIPATION_MS } : {}), ...(process.env.MMM_APRES_MS ? { MMM_APRES_MS: process.env.MMM_APRES_MS } : {}),
    // Doublure et ambiance (portées de palazzo-v1). HEDGE_APRES_MS=300 la fait demander à CHAQUE tour,
    // DOUBLURE_TEST_MS=3000 la fait gagner à coup sûr sans attendre un vrai pic de Grok.
    ...(process.env.HEDGE_APRES_MS ? { HEDGE_APRES_MS: process.env.HEDGE_APRES_MS } : {}),
    ...(process.env.DOUBLURE_TEST_MS ? { DOUBLURE_TEST_MS: process.env.DOUBLURE_TEST_MS } : {}),
    // Ambiance CONTINUE (19/09/2026) : AMBIANCE=<preset|chemin|url> suffit, il n'y a plus de seuil de
    // declenchement. AMBIANCE=centre-appels pour l'entendre sur l'enregistrement du banc.
    ...(process.env.AMBIANCE ? { AMBIANCE: process.env.AMBIANCE } : {}),
    ...(process.env.AMBIANCE_GAIN ? { AMBIANCE_GAIN: process.env.AMBIANCE_GAIN } : {}),
    ...(process.env.AMBIANCE_RATIO_VOIX ? { AMBIANCE_RATIO_VOIX: process.env.AMBIANCE_RATIO_VOIX } : {}),
  },
});
const t0 = Date.now();
const horo = () => `${((Date.now() - t0) / 1000).toFixed(2)}`.padStart(6);
for (const flux of [pont.stdout, pont.stderr]) flux.on("data", (d) => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) journal.push(`${horo()} ${l}`); });

let ws = null;
for (let i = 0; i < 40 && !ws; i++) {
  await attendre(250);
  try { ws = await new Promise((ok, ko) => { const w = new WebSocket(`ws://127.0.0.1:${PORT}/twilio`); w.onopen = () => ok(w); w.onerror = () => ko(new Error("pas encore")); }); } catch {}
}
if (!ws) { console.log("le pont ne répond pas"); pont.kill(); process.exit(1); }

// ---- Twilio simulé : file de lecture, marks, clear ----
const DUREE_MAX_S = 150;
const agent = new Int16Array(8000 * DUREE_MAX_S), client = new Int16Array(8000 * DUREE_MAX_S);
let debutFlux = 0, finLecture = 0; // ms murales
const marks = []; // { nom, a }
const ecrits = []; // { de, a } échantillons de l'agent planifiés
const ech = (ms) => Math.max(0, Math.round(((ms - debutFlux) / 1000) * 8000));
const agentParle = () => Date.now() < finLecture;
let premierSonApres = null, dernierSonAgent = 0, sonsAgent = 0, reponsesAgent = 0;
let fondSeul = 0; // octets recus sous le seuil de parole : le fond sonore, quand il y en a un
const latences = [];
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
    /* ⚠ TOUT PAQUET N'EST PAS DE LA PAROLE (19/09/2026). Depuis le fond sonore continu, le pont envoie des
       paquets SANS DISCONTINUER pendant tout l'appel. Ce banc deduisait « l'agent parle » de la simple arrivee
       d'un paquet : `finLecture` ne redescendait donc plus jamais, `silenceAgent()` n'etait plus jamais vrai, et
       le banc attendait ses 30 a 40 s de delai de garde avant CHAQUE replique du client. L'appel entier
       deraillait, et tout accusait l'ambiance alors que le pont etait sain. On mesure donc le NIVEAU : le fond
       tourne a 0,0044 de niveau efficace (0,06 en crete), la voix a 0,05 et plus, il y a un ordre de grandeur
       entre les deux. En dessous du seuil, le paquet est enregistre dans la voie agent mais ne compte pas comme
       de la parole. C'est aussi ce que fait le pont lui-meme pour la voix du client. */
    let somme = 0;
    for (let i = 0; i < u.length; i++) { const v = ulawDecodeSample(u[i]) / 32768; somme += v * v; }
    const niveau = Math.sqrt(somme / Math.max(1, u.length));
    if (niveau < 0.02) { fondSeul += u.length; return; }
    if (!agentParle()) reponsesAgent++;
    if (!agentParle() && premierSonApres) { latences.push(debut - premierSonApres); journal.push(`${horo()} [banc] premier son de l'agent ${debut - premierSonApres} ms après la fin du client`); premierSonApres = null; }
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
envoyer({ event: "start", start: { streamSid: "MZbanc", callSid: "CAbanc", customParameters: { from: "+33612345678" } } });
debutFlux = Date.now();

// ---- Client simulé : 20 ms à chaque pas, silence ou morceau en cours, plus l'écho éventuel de l'agent ----
let enCours = null, pos = 0, trame = 0, fini = false;
const jouer = (nom) => new Promise((ok) => {
  enCours = { nom, buf: MORCEAUX[nom], ok, pendantAgent: agentParle() }; pos = 0;
  journal.push(`${horo()} [banc] client dit « ${nom} »${agentParle() ? " PENDANT que l'agent parle" : ""}`);
});
(async () => {
  while (!fini) {
    const due = Math.floor((Date.now() - debutFlux) / 20);
    while (trame <= due) {
      const i0 = trame * 160;
      const f = Buffer.alloc(160);
      for (let i = 0; i < 160; i++) {
        let s = 0;
        if (enCours && pos + i * 2 + 1 < enCours.buf.length) s = enCours.buf.readInt16LE(pos + i * 2);
        if (ECHO && i0 + i - ECHO_RETARD >= 0) s += Math.round(agent[i0 + i - ECHO_RETARD] * ECHO);
        s = Math.max(-32768, Math.min(32767, s));
        if (i0 + i < client.length) client[i0 + i] = s;
        f[i] = ulawEncodeSample(s);
      }
      if (enCours) {
        pos += 320;
        if (pos >= enCours.buf.length) { const k = enCours; enCours = null; premierSonApres = agentParle() ? null : Date.now(); k.ok(); }
      }
      envoyer({ event: "media", streamSid: "MZbanc", media: { payload: f.toString("base64") } });
      trame++;
    }
    await attendre(10);
  }
})();

const jusqua = async (cond, maxMs) => { const d = Date.now(); while (!cond() && Date.now() - d < maxMs) await attendre(50); };
const silenceAgent = (ms) => () => sonsAgent > 0 && !agentParle() && Date.now() - dernierSonAgent > ms;
const tourDeParole = async (nom) => { await jouer(nom); const avant = reponsesAgent; await jusqua(() => reponsesAgent > avant, 12000); await jusqua(silenceAgent(1500), 40000); };

// Scénario
await jusqua(silenceAgent(1000), 30000);                 // accueil fini
await jouer("besoin");
let avant = reponsesAgent;
await jusqua(() => reponsesAgent > avant, 12000);        // l'agent commence sa réponse
await attendre(1200);
await jouer("mmm");                                      // bref, pendant la réponse : ne doit ni couper ni devenir un tour
await jusqua(silenceAgent(1500), 40000);
await tourDeParole("nom-pause");                         // pause de 850 ms au milieu : un seul tour attendu
await jouer("email");
avant = reponsesAgent;
await jusqua(() => reponsesAgent > avant, 12000);        // l'agent épelle
await attendre(1500);
await jouer("par-dessus");                               // dit par-dessus l'agent
await jusqua(silenceAgent(1500), 40000);
await tourDeParole("confirmer");
await tourDeParole("ville");
await tourDeParole("confirmer");
await tourDeParole("au-revoir");
await attendre(500);
fini = true;
envoyer({ event: "stop", streamSid: "MZbanc" });
await attendre(2000);
const admin = await fetch(`http://127.0.0.1:${PORT}/admin?key=banc`).then((r) => r.text()).catch(() => "");
ws.close();
pont.kill();

// Dialogue tel que le tableau de bord (et donc le récap) le garde
const dernier = admin.split(/Derniers appels/)[1] || "";
const dialogue = dernier.split(/<div style="margin:2px 0">/).slice(1).map((b) => b.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&middot;/g, "·").trim()).join("\n");

// Enregistrement stéréo : gauche agent, droite client
const n = Math.min(agent.length, Math.ceil(((Date.now() - debutFlux) / 1000) * 8000));
const data = Buffer.alloc(n * 4);
for (let i = 0; i < n; i++) { data.writeInt16LE(agent[i], i * 4); data.writeInt16LE(client[i], i * 4 + 2); }
const h = Buffer.alloc(44);
h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16);
h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000 * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
h.write("data", 36); h.writeUInt32LE(data.length, 40);
fs.writeFileSync(path.join(SORTIES, `${NOM}.wav`), Buffer.concat([h, data]));
fs.writeFileSync(path.join(SORTIES, `${NOM}.log`), `${journal.join("\n")}\n\n--- dialogue ---\n${dialogue}\n`);
console.log(journal.filter((l) => /\[banc\]|\[tour\]|\[latence\]|\[reponse\]|coupe|erreur|\[session\]|\[son\]|\[doublure\]|\[ambiance\]|\[redite\]|jamais|toujours/.test(l)).map((l) => l.replace(/ sid=CA\w+/, "").slice(0, 230)).join("\n"));
const med = [...latences].sort((a, b) => a - b)[Math.floor(latences.length / 2)];
console.log(`\n--- latences (fin du client -> premier son) : ${latences.join(", ")} ms ; médiane ${med} ms`);
if (fondSeul) console.log(`--- fond sonore : ${(fondSeul / 8000).toFixed(1)} s reçues sous le seuil de parole (elles sont dans l'enregistrement, mais ne comptent pas comme de la parole)`);
console.log(`--- dialogue ---\n${dialogue}`);
process.exit(0);
