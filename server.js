// voice-reception-bridge
// Pont entre Twilio Media Streams (G.711 mu-law 8kHz) et xAI Grok Voice (PCM16).
// Un appel entrant Twilio -> <Connect><Stream> vers /twilio -> ce serveur ponte l'audio
// vers Grok Voice, capte le transcript, et POST un recap a n8n a la fin de l'appel.
//
// Variables d'environnement (voir .env.example) :
//   XAI_API_KEY        cle xAI (jamais en clair dans le code)
//   GROK_MODEL         defaut grok-voice-latest
//   GROK_VOICE         eve | ara | rex | sal | leo  (defaut eve)
//   GROK_RATE          rate PCM16 declare a Grok. 8000 = pas de resampling (a tester en 1er).
//   AGENT_LANG         fr | es | en  (defaut fr)
//   AGENT_NAME         nom de l'agent (defaut Dany)
//   BUSINESS_NAME      nom du commerce
//   BUSINESS_DESC      description courte (pour cadrer l'agent)
//   N8N_RECAP_URL      webhook n8n qui fait extraction + format + mail
//   RECAP_EXCLURE      numeros appelants de test (E.164, virgules) : leurs appels n'envoient pas de recap
//   TOURS             "pont" (defaut) : le pont decide de la fin des tours ; "grok" : detecteur de Grok (ancien mode)
//   FIN_DE_TOUR_MS     silence du client qui termine son tour, en mode pont (defaut 1000)
//   BARGE_IN           "1" : le client peut couper la parole a l'agent ; sinon demi-duplex (anti-echo)
//   PAROLE_COUPURE_MS, FENETRE_VOIX_MS, SEUIL_SON_RMS, AGENT_SPEAKING_MAX_MS   reglages fins des tours
//   EVITER_FIN_SUR_QUESTION  "1" : consigne de ne jamais finir une reponse sur une question (voix qui l'avalent)
//   PORT               injecte par Railway

import http from "http";
import fs from "fs";
import { WebSocketServer, WebSocket } from "ws";
import { ulaw8kToPcm16, pcm16ToUlaw8k } from "./lib/audio.js";

const PORT = process.env.PORT || 8080;
const XAI_API_KEY = process.env.XAI_API_KEY;
const GROK_MODEL = process.env.GROK_MODEL || "grok-voice-latest";
const GROK_VOICE = process.env.GROK_VOICE || "eve";
const GROK_RATE = Number(process.env.GROK_RATE || 8000);
const GROK_SPEED = Number(process.env.GROK_SPEED || 1.0);          // vitesse de parole (0.7..1.5)
const GROK_VAD_THRESHOLD = Number(process.env.GROK_VAD_THRESHOLD || 0.6); // reactivite VAD (0.1..0.9 ; plus bas = plus sensible), mode TOURS=grok seulement
const GROK_REASONING = process.env.GROK_REASONING || "high";       // "high" = profond, "none" = rapide
const AGENT_LANG = process.env.AGENT_LANG || "fr";
const AGENT_NAME = process.env.AGENT_NAME || "Dany";
const BUSINESS_NAME = process.env.BUSINESS_NAME || "l'entreprise";
const BUSINESS_DESC = process.env.BUSINESS_DESC || "";
const N8N_RECAP_URL = process.env.N8N_RECAP_URL || "";
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // protege le tableau de bord /admin
// NUMEROS DE TEST (17/09/2026) : chaque appel sur la ligne de Dany part en lead chez Motralec par n8n. Couper tout le
// recap pendant une recette ferait perdre les vrais appels du moment ; seuls les numeros listes ici (E.164, separes
// par des virgules) n'en envoient pas. L'appel reste visible dans /admin.
const RECAP_EXCLURE = new Set((process.env.RECAP_EXCLURE || "").split(",").map((n) => n.replace(/[^\d+]/g, "")).filter(Boolean));
const AGENT_SPEAKING_MAX_MS = Number(process.env.AGENT_SPEAKING_MAX_MS || 12000); // filet anti-surdite si le mark de fin de parole se perd
const BARGE_IN = process.env.BARGE_IN === "1";
// Les correctifs ci-dessous viennent du chantier Palazzo Pizza (branche palazzo-v1, 16-17/09/2026), mesures sur
// la vraie API de Grok et rejoues sur le banc local (test/bancs). Doctrine : skill agent-voice,
// references/telephony-reception.md § 7 bis.
//
// COUPER L'AGENT SUR UNE VRAIE PRISE DE PAROLE (BARGE_IN=1 seulement). Le pont mesure lui-meme au moins
// PAROLE_COUPURE_MS de voix au-dessus du seuil sur les FENETRE_VOIX_MS dernieres millisecondes : un « mmm » ou un
// « oui » n'y arrive pas, une phrase si. 400 ms : une interjection humaine (« attendez », « non non ») tient en
// 400 a 700 ms ; calibre a 700 ms sur une voix de synthese, l'agent ne se laissait plus jamais couper.
const PAROLE_COUPURE_MS = Number(process.env.PAROLE_COUPURE_MS || 400);
// Les ACCUEIL_PROTEGE_MS premieres secondes de l'accueil ne se coupent pas ; un son doit y durer PAROLE_ACCUEIL_MS.
const ACCUEIL_PROTEGE_MS = 5000;
const PAROLE_ACCUEIL_MS = 700;
const FENETRE_VOIX_MS = Number(process.env.FENETRE_VOIX_MS || 1500);
const SEUIL_SON_RMS = Number(process.env.SEUIL_SON_RMS || 600); // PCM16 ; le journal [son] de fin d'appel sert a le regler
// LE PONT DECIDE DE LA FIN DES TOURS. Trois faits mesures sur l'API de Grok :
// 1) son detecteur annonce la fin d'une phrase 1,4 a 1,6 s apres le dernier mot, quels que soient le seuil et
//    silence_duration_ms. En mode manuel (audio.input.turn_detection: null ; `{ type: null }` a la racine NE le
//    desactive PAS), le pont valide apres FIN_DE_TOUR_MS de silence ;
// 2) Grok ARRETE NET la reponse qu'il genere des qu'il entend le client, meme un « mmm », et la dit quand meme
//    « completed ». Pendant qu'il genere, la voix du client est donc retenue par le pont et lui est envoyee apres ;
// 3) un son bref pendant que l'agent parle (« mmm », « oui ») n'est pas un tour : il est efface.
// TOURS=grok remet l'ancien fonctionnement (detecteur de Grok) sans toucher au code.
const TOURS_PAR_LE_PONT = (process.env.TOURS || "pont").toLowerCase() !== "grok";
// 1000 ms et non 600 : a 600 ms, « Euh des pizzas pour… deux personnes » faisait deux tours chez Palazzo (valide
// ensuite a 900 ms). Dany fait epeler des emails et des numeros de devis, ou les pauses sont plus longues ; le
// detecteur de Grok en tolerait ~1,4 s. Premier son attendu vers 1,8 s apres le dernier mot (2,2 s avant).
const FIN_DE_TOUR_MS = Math.min(1500, Math.max(500, Number(process.env.FIN_DE_TOUR_MS || 1000)));
const PREROLL_PAQUETS = 15;   // 300 ms de son envoyes avant le debut detecte d'une prise de parole
const TOUR_MAX_MS = 20000;    // filet : une ligne trop bruyante ne garde pas le tour ouvert indefiniment
// GROK AVALE LA FIN DES QUESTIONS avec certaines voix (Palazzo, voix eve et autres voix feminines : 27 fins coupees
// sur 27). Mesure le 17/09/2026 avec la voix leo de Dany : 0 sur 16. Consigne donc optionnelle.
const EVITER_FIN_SUR_QUESTION = process.env.EVITER_FIN_SUR_QUESTION === "1";
function rmsPcm16(buf) {
  const n = buf.length >> 1;
  if (!n) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) { const v = buf.readInt16LE(i * 2); s += v * v; }
  return Math.sqrt(s / n);
}

if (!XAI_API_KEY) console.error("[boot] ATTENTION: XAI_API_KEY manquante");

// Historique des derniers appels (pour le tableau de bord /admin).
// Persiste sur un volume Railway si CALLS_FILE est defini (sinon en memoire, perdu au redeploiement).
const CALLS_FILE = process.env.CALLS_FILE || "";
function loadCalls() {
  if (!CALLS_FILE) return [];
  try { const a = JSON.parse(fs.readFileSync(CALLS_FILE, "utf8")); return Array.isArray(a) ? a : []; } catch { return []; }
}
function saveCalls() {
  if (!CALLS_FILE) return;
  try { fs.writeFileSync(CALLS_FILE, JSON.stringify(recentCalls)); } catch (e) { console.error("[calls] save KO", e.message); }
}
const recentCalls = loadCalls(); // { ts, from, sid, endReason, dialog }
function pushCall(c) { recentCalls.unshift(c); if (recentCalls.length > 100) recentCalls.length = 100; saveCalls(); }
function escHtml(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function normLine(s) { return String(s).toLowerCase().replace(/[^0-9a-zà-ÿ@ ]/gi, " ").replace(/\s+/g, " ").trim(); }
function frPhone(e164) { const m = String(e164 || "").replace(/\s/g, "").match(/^\+33(\d{9})$/); return m ? "0" + m[1] : (e164 || ""); }
// Numero FR -> lecture orale pre-calculee par paires (deterministe cote JS). On NE laisse PAS Grok
// calculer les groupes/mots : il se trompe sur les longues suites de chiffres et les nombres composes
// (quatre-vingt-seize, soixante-dix-huit...). On lui donne la phrase finie a repeter telle quelle.
function frUnit(n) { return ["zéro","un","deux","trois","quatre","cinq","six","sept","huit","neuf","dix","onze","douze","treize","quatorze","quinze","seize","dix-sept","dix-huit","dix-neuf"][n]; }
function frTwoDigits(n) {
  if (n < 20) return frUnit(n);
  if (n < 70) { const t = Math.floor(n / 10), u = n % 10, tw = { 2: "vingt", 3: "trente", 4: "quarante", 5: "cinquante", 6: "soixante" }[t]; return u === 0 ? tw : u === 1 ? tw + "-et-un" : tw + "-" + frUnit(u); }
  if (n < 80) return n === 71 ? "soixante-et-onze" : "soixante-" + frUnit(n - 60);
  if (n === 80) return "quatre-vingts";
  return "quatre-vingt-" + frUnit(n - 80); // 81..99 (dont 90..99 = quatre-vingt-dix..dix-neuf)
}
function frPhoneSpoken(fr) {
  const d = String(fr).replace(/\D/g, ""), out = [];
  for (let i = 0; i < d.length; i += 2) {
    const p = d.slice(i, i + 2);
    if (p.length === 1) out.push(frUnit(Number(p)));
    else if (p[0] === "0") out.push("zéro " + frUnit(Number(p[1])));
    else out.push(frTwoDigits(Number(p)));
  }
  return out.join(", ");
}

// Instruction de l'agent de reception (cf. agent-voiceflow-creator : voice_intake.md / voice_agent.md).
// Configurable par env (AGENT_NAME / BUSINESS_NAME / BUSINESS_DESC), surchargeable via RECEPTION_PROMPT.
const RECEPTION_PROMPT = process.env.RECEPTION_PROMPT || `Tu es ${AGENT_NAME}, l'assistant vocal telephonique de ${BUSINESS_NAME}${BUSINESS_DESC ? " (" + BUSINESS_DESC + ")" : ""}. Tu decroches quand le standard est ferme (hors horaires). Tu vouvoies, tu es chaleureux, calme et clair, une idee par phrase, une seule question a la fois.

Tu fais le tri :
- Question simple que tu connais (horaires, adresse, services) : tu reponds directement, tu ne demandes aucune coordonnee.
- Vrai besoin (devis, SAV, suivi, demande de rappel) : tu qualifies puis tu transmets pour rappel. Tu captes, dans l'ordre, une info a la fois : le besoin precis, puis le nom et le prenom, puis l'adresse email (demandee une seule fois, sans epeler), puis la ville. Le numero de telephone est deja connu (le numero appelant).

Tu confirmes a voix haute les marques, references et noms (pieges phonetiques). Tu ne donnes jamais de prix, de delai ferme ni de disponibilite ; tu dis qu'un conseiller confirmera. Tu n'inventes jamais une information.

A la fin, tu dis une phrase de cloture ("toute l'equipe vous remercie, un conseiller vous rappellera, bonne journee") et tu laisses la personne raccrocher. Tu n'envoies aucun mail toi-meme : le recap part automatiquement.

Reponds toujours en ${AGENT_LANG === "es" ? "espagnol" : AGENT_LANG === "en" ? "anglais" : "francais"}.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// File de reessai en memoire : si n8n est injoignable au raccrochage, on garde
// le recap et on retente, pour qu'un hoquet reseau ne perde jamais un appel.
const pendingRecaps = [];

async function postRecap(payload, attempts) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(N8N_RECAP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (r.ok) return true;
      console.error(`[recap] n8n status ${r.status} (essai ${i + 1}/${attempts}) sid=${payload.call_sid}`);
    } catch (e) {
      console.error(`[recap] echec POST essai ${i + 1}/${attempts} sid=${payload.call_sid}: ${e.message}`);
    }
    if (i < attempts - 1) await sleep(1000 * Math.pow(2, i)); // 1s, 2s, 4s...
  }
  return false;
}

// Reessai de fond toutes les 60s pour les recaps qui n'ont pas pu partir au raccrochage.
setInterval(async () => {
  if (!pendingRecaps.length || !N8N_RECAP_URL) return;
  const batch = pendingRecaps.splice(0, pendingRecaps.length);
  for (const p of batch) {
    const ok = await postRecap(p, 2);
    if (ok) console.log(`[recap] renvoye depuis la file sid=${p.call_sid}`);
    else pendingRecaps.push(p);
  }
}, 60000);

function renderDashboard() {
  const tours = TOURS_PAR_LE_PONT ? `tours pont ${FIN_DE_TOUR_MS} ms` : `tours grok VAD ${GROK_VAD_THRESHOLD}`;
  const cfg = `voix ${GROK_VOICE} · vitesse ${GROK_SPEED} · ${tours} · coupure ${BARGE_IN ? "oui" : "non"} · raisonnement ${GROK_REASONING} · rate ${GROK_RATE} · langue ${AGENT_LANG}`;
  const calls = recentCalls.map((c) => {
    const lines = escHtml(c.dialog).split("\n").map((l) => {
      const m = l.match(/^(Client|Agent)\s*:\s*([\s\S]*)$/);
      if (!m) return `<div>${l}</div>`;
      const who = m[1] === "Client" ? "Client" : AGENT_NAME;
      const color = m[1] === "Client" ? "#1d4ed8" : "#0a7d4b";
      return `<div style="margin:2px 0"><span style="color:${color};font-weight:600">${who}</span> : ${m[2]}</div>`;
    }).join("");
    return `<div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin:12px 0;background:#fff">
      <div style="font-size:12px;color:#6b7280;margin-bottom:8px">${escHtml(c.ts)} &middot; ${escHtml(c.from || "inconnu")} &middot; fin : ${escHtml(c.endReason)}</div>
      <div style="font-size:14px;line-height:1.5;color:#111827">${lines}</div>
    </div>`;
  }).join("") || '<p style="color:#6b7280">Aucun appel enregistre pour le moment.</p>';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(AGENT_NAME)} - ${escHtml(BUSINESS_NAME)} - suivi</title></head>
  <body style="font-family:Segoe UI,Roboto,Arial,sans-serif;background:#f3f4f6;margin:0;padding:24px;color:#111827">
  <div style="max-width:780px;margin:0 auto">
    <h1 style="font-size:22px;margin:0 0 4px">${escHtml(AGENT_NAME)} &middot; ${escHtml(BUSINESS_NAME)}</h1>
    <div style="color:#6b7280;font-size:13px;margin-bottom:18px">${escHtml(cfg)} &middot; ${recentCalls.length} appel(s) en memoire</div>
    <details style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:18px">
      <summary style="cursor:pointer;font-weight:600">Prompt actuel de l'agent</summary>
      <pre style="white-space:pre-wrap;font-size:12px;color:#374151;margin-top:10px">${escHtml(RECEPTION_PROMPT)}</pre>
    </details>
    <h2 style="font-size:16px;margin:0 0 4px">Derniers appels (le plus recent en haut)</h2>
    ${calls}
  </div></body></html>`;
}

const server = http.createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];
  if (path === "/admin") {
    const key = new URL(req.url, "http://x").searchParams.get("key") || "";
    if (!ADMIN_KEY || key !== ADMIN_KEY) { res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" }); res.end("non autorise"); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderDashboard());
    return;
  }
  if (path === "/twiml") {
    // Webhook Voice de Twilio : renvoie le TwiML qui connecte l'appel au pont WS.
    // On injecte le numero appelant (From) pour que le pont le connaisse (recap).
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const fromBody = new URLSearchParams(body).get("From");
      const fromQuery = new URL(req.url, "http://x").searchParams.get("From");
      const from = (fromBody || fromQuery || "").replace(/[<>&"']/g, "");
      const host = req.headers.host;
      const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://${host}/twilio"><Parameter name="from" value="${from}"/></Stream></Connect></Response>`;
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(xml);
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("voice-reception-bridge ok");
});
const wss = new WebSocketServer({ server, path: "/twilio" });

wss.on("connection", (twilio) => {
  let streamSid = null;
  let callSid = null;
  let fromNumber = null;
  const debutAppelMs = Date.now();
  let grok = null;
  let grokReady = false;
  const dialog = []; // { who: 'Client' | 'Agent', msg }
  let userBuf = "";
  let agentBuf = "";
  let finalized = false;
  let endRequested = false;
  let endReason = "raccroche par le client";
  let closingSaid = false;
  let checkedIn = false;
  let closeTriggered = false;
  let lastCallerMs = Date.now();
  let audioReponseOctets = 0, debutReponseMs = 0; // audio mu-law envoye a Twilio pour la reponse en cours (8000 octets = 1 s)
  let premierSon = false, finParoleClientMs = 0; // mesure de la latence percue par l'appelant
  let reponseCoupee = 0;                        // reponse dont l'audio restant est jete
  let parleSelonGrok = false;                   // entre speech_started et speech_stopped (mode grok)
  let entenduSurAgent = false, voixMaxTour = 0, coupeCeTour = false; // pour le journal « son bref ignore »
  let accueilProtegeJusqua = Infinity;          // rien ne se coupe avant le premier son, puis le debut de l'accueil
  const voixFenetre = new Array(Math.max(1, Math.round(FENETRE_VOIX_MS / 20))).fill(0); // ms de voix par paquet de 20 ms
  let voixFenetreIdx = 0, voixRecenteMs = 0;
  const sonHisto = [0, 0, 0, 0, 0, 0];         // niveaux de la voix du client par paquet : <150 <300 <600 <1200 <2400 >=2400
  const sonHistoAgent = [0, 0, 0, 0, 0, 0];    // les memes, seulement pendant que l'agent est audible : l'echo d'une ligne se voit ici
  // HORODATAGE RELATIF : Railway regroupe les lignes de journal et leur donne parfois la meme heure a plusieurs
  // secondes d'ecart, ce qui rend illisible l'ordre reel des evenements d'un tour.
  const t = () => `t+${((Date.now() - debutAppelMs) / 1000).toFixed(2)}`;
  const typesVus = new Set();
  // Tours decides par le pont (voir TOURS_PAR_LE_PONT).
  let generation = false, generationDemandeeA = 0; // Grok genere une reponse : la voix du client est retenue
  let reponseActive = false;                    // entre response.created et response.done
  let retenue = [];                             // paquets PCM retenus pendant la generation
  let tour = null;                              // prise de parole en cours : { debut, voixMs, derniereVoix, coupe }
  const preroll = [];
  let tourEnAttente = false;                    // prise de parole finie pendant une generation
  const niveaux = new Float32Array(250);        // 5 s de niveaux : plancher de bruit de la ligne
  let niveauxIdx = 0, niveauxN = 0, seuilVoix = SEUIL_SON_RMS, seuilCalculeA = 0, seuilMax = SEUIL_SON_RMS;
  let toursValides = 0, toursIgnores = 0;
  let respSeq = 0;         // numero de la reponse en cours : le mark "agentdone" d'une reponse finie ne doit pas rouvrir l'ecoute pendant la suivante
  // FIN DE LECTURE ESTIMEE : chaque octet mu-law envoye a Twilio dure 1/8000 s. Le compte a rebours du silence part
  // de la fin REELLE de ce que l'agent dit : une longue reponse declenchait « vous etes toujours la ? » juste apres.
  let finLecture = 0;
  // ERREUR TWILIO 31924 (Palazzo, 16/09/2026) : appels coupes net pendant que l'agent parlait, « Stream - Websocket -
  // Protocol Error ». Un delta audio de Grok peut arriver avec un nombre IMPAIR d'octets : le dernier octet etait
  // perdu (echantillons decales ensuite) et un delta d'un octet donnait un media VIDE. On garde l'octet orphelin
  // pour le delta suivant et on n'envoie jamais de charge vide.
  let resteAudio = Buffer.alloc(0);
  let mediasVides = 0;
  let agentSpeaking = false, agentSpeakingSince = 0; // half-duplex anti-echo : tant que Dany parle (jusqu'a la fin de lecture Twilio, signalee par le mark "agentdone"), on ne renvoie PAS l'audio a Grok, sinon son propre echo declenche un faux tour et il enchaine les questions

  // Raccroche proprement : on laisse jouer l'audio de cloture deja envoye a Twilio (mark),
  // puis on ferme le flux Twilio -> Twilio termine l'appel -> twilio.on("close") -> finalize() -> recap.
  function requestHangup(reason) {
    if (endRequested || finalized) return;
    endRequested = true;
    endReason = reason;
    console.log(`[call] hangup (${reason}) sid=${callSid}`);
    if (streamSid) { try { twilio.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "hangup" } })); } catch {} }
    setTimeout(() => { try { twilio.close(); } catch {} }, 7000); // filet si Twilio ne renvoie pas le mark
  }

  // Le client parle vraiment par-dessus l'agent (BARGE_IN=1) : on vide la file Twilio et on jette la suite de la
  // reponse en cours. Pas de response.cancel : la doc xAI le dit non supporte.
  function couperAgent(sonMs) {
    if (finalized) return;
    if (streamSid) { try { twilio.send(JSON.stringify({ event: "clear", streamSid })); } catch {} }
    finLecture = Date.now();
    reponseCoupee = respSeq;
    pushAgent();
    agentSpeaking = false;
    console.log(`[turn] client coupe l'agent (reponse n°${respSeq}, ${Math.round(sonMs)} ms de voix) ${t()} sid=${callSid}`);
  }

  // Appele a chaque paquet du client (et, en mode grok, au debut de parole signale par Grok).
  function verifierCoupure() {
    if (!BARGE_IN || finalized || !(TOURS_PAR_LE_PONT ? tour : parleSelonGrok)) return;
    const maintenant = Date.now();
    if (maintenant >= finLecture || maintenant < accueilProtegeJusqua) return; // rien d'audible, ou le debut de l'accueil
    entenduSurAgent = true;
    if (voixRecenteMs > voixMaxTour) voixMaxTour = voixRecenteMs;
    if (voixRecenteMs >= PAROLE_COUPURE_MS && reponseCoupee !== respSeq) {
      coupeCeTour = true;
      if (tour) tour.coupe = true;
      couperAgent(voixRecenteMs);
    }
  }

  // ---- Tours decides par le pont ----
  function envoyerAGrok(paquets) {
    if (!(grok && grok.readyState === WebSocket.OPEN && grokReady)) return;
    for (const p of paquets) {
      if (generation) { retenue.push(p); continue; } // Grok abandonnerait la reponse qu'il genere
      grok.send(JSON.stringify({ type: "input_audio_buffer.append", audio: p.toString("base64") }));
    }
  }
  function lacherRetenue() {
    const paquets = retenue;
    retenue = [];
    envoyerAGrok(paquets);
  }
  function marquerGeneration() {
    generation = true;
    generationDemandeeA = Date.now();
  }
  function demanderReponse() {
    if (!(grok && grok.readyState === WebSocket.OPEN)) return;
    marquerGeneration();
    grok.send(JSON.stringify({ type: "response.create" }));
  }
  // La prise de parole devient un message du client dans la conversation de Grok.
  function validerTour() {
    tourEnAttente = false;
    if (!(grok && grok.readyState === WebSocket.OPEN)) return;
    grok.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    tourClient = { idx: null };
    checkedIn = false;
    toursValides++;
  }
  function finDuTour() {
    const fini = tour;
    tour = null;
    // L'agent parle encore bien apres ce son : « mmm », « oui », un souffle. Sans BARGE_IN, ce qui est dit pendant
    // que l'agent est audible n'est meme pas compte (voir le handler media) : il ne reste ici que la voix d'avant son
    // premier son, par exemple la fin d'une phrase reprise juste apres une pause.
    const agentContinue = !fini.coupe && finLecture > fini.derniereVoix + 500;
    const pendantAccueil = fini.derniereVoix < accueilProtegeJusqua;
    const voixMinimale = pendantAccueil ? PAROLE_ACCUEIL_MS : PAROLE_COUPURE_MS;
    if (fini.voixMs < 150 || (agentContinue && fini.voixMs < voixMinimale)) {
      toursIgnores++;
      console.log(`[tour] son ignore : ${Math.round(fini.voixMs)} ms de voix${agentContinue ? " pendant que l'agent parle" : ""} ${t()}`);
      if (tourEnAttente) {
        // Une vraie prise de parole attend d'etre validee et son audio est dans le meme tampon : on garde le
        // tout (le son bref ne gene pas la transcription) plutot que d'effacer la question avec.
        if (!generation) { validerTour(); demanderReponse(); }
        return;
      }
      if (generation) retenue = []; // rien d'autre n'est retenu que ce son
      else if (grok && grok.readyState === WebSocket.OPEN) grok.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
      userBuf = "";
      return;
    }
    finParoleClientMs = fini.derniereVoix;
    console.log(`[tour] client : ${Math.round(fini.voixMs)} ms de voix, dernier son a t+${((fini.derniereVoix - debutAppelMs) / 1000).toFixed(2)}${generation ? ", valide apres la reponse en cours" : ""} ${t()}`);
    if (generation) { tourEnAttente = true; return; }
    validerTour();
    demanderReponse();
  }

  // Anti-doublons : la transcription Grok est cumulative et peut etre flushee plusieurs fois
  // par tour (pauses + barge-in). Si la nouvelle ligne prolonge la precedente du meme locuteur, on remplace.
  function pushLine(who, raw) {
    const t = (raw || "").trim();
    if (!t) return;
    const last = dialog[dialog.length - 1];
    if (last && last.who === who) {
      const a = normLine(last.msg), b = normLine(t);
      if (a && b && (b.startsWith(a) || a.startsWith(b))) { last.msg = t.length >= last.msg.length ? t : last.msg; return; }
    }
    dialog.push({ who, msg: t });
  }
  // Ligne client du tour en cours. La transcription arrive souvent APRES response.created : on reserve
  // alors la place de la ligne pour qu'elle reste avant la reponse de l'agent, et on la remplit ensuite.
  let tourClient = null; // { idx } depuis la derniere prise de parole
  function pushUser() {
    if (!tourClient || tourClient.idx != null) { if (userBuf.trim()) pushLine("Client", userBuf); userBuf = ""; return; }
    tourClient.idx = dialog.length;
    dialog.push({ who: "Client", msg: userBuf.trim() });
    userBuf = "";
  }
  function setUser(texte, cumule) {
    if (typeof texte !== "string") return;
    if (tourClient && tourClient.idx != null && dialog[tourClient.idx]) {
      const l = dialog[tourClient.idx];
      l.msg = (cumule ? l.msg + texte : texte).replace(/^\s+/, "");
    } else userBuf = cumule ? userBuf + texte : texte;
  }
  function pushAgent() { pushLine("Agent", agentBuf); agentBuf = ""; }

  async function openGrok() {
    let token;
    try {
      const tok = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
        method: "POST",
        headers: { Authorization: `Bearer ${XAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expires_after: { seconds: 600 } }),
      }).then((r) => r.json());
      token = tok.value || tok.secret || tok.token || (tok.client_secret && tok.client_secret.value);
    } catch (e) {
      console.error("[grok] token error", e);
      return;
    }
    if (!token) { console.error("[grok] pas de token"); return; }

    grok = new WebSocket(`wss://api.x.ai/v1/realtime?model=${GROK_MODEL}`, [`xai-client-secret.${token}`]);

    grok.on("open", () => {
      const callerFr = frPhone(fromNumber);
      const callerSpoken = callerFr ? frPhoneSpoken(callerFr) : "";
      const contexte = [
        callerFr ? `Le client appelle depuis le numéro ${callerFr}. Quand tu lui relis ce numéro à voix, tu prononces EXACTEMENT ceci, mot pour mot, sans le recalculer ni changer un seul groupe : « ${callerSpoken} ». C'est son numéro de rappel par défaut, tu le connais déjà.` : "",
        EVITER_FIN_SUR_QUESTION ? "Au téléphone, ta voix avale la fin d'une réponse qui se termine sur une question. Ne finis donc jamais sur le point d'interrogation : après ta question, ajoute toujours deux ou trois mots, variés d'une fois sur l'autre (« Je vous écoute. », « Dites-moi. », « Prenez votre temps. »)." : "",
      ].filter(Boolean).join("\n");
      const sessionInstructions = contexte ? `${RECEPTION_PROMPT}\n\n# Contexte de cet appel\n${contexte}` : RECEPTION_PROMPT;
      console.log(`[session] modele=${GROK_MODEL} voix=${GROK_VOICE} reflexion=${GROK_REASONING} tours=${TOURS_PAR_LE_PONT ? "pont fin_de_tour=" + FIN_DE_TOUR_MS + "ms" : "grok seuil=" + GROK_VAD_THRESHOLD} vitesse=${GROK_SPEED} coupure=${BARGE_IN ? "oui" : "non"} ${t()} sid=${callSid}`);
      grok.send(JSON.stringify({
        type: "session.update",
        session: {
          instructions: sessionInstructions,
          voice: GROK_VOICE,
          reasoning: { effort: GROK_REASONING },
          ...(TOURS_PAR_LE_PONT ? {} : { turn_detection: { type: "server_vad", threshold: GROK_VAD_THRESHOLD, prefix_padding_ms: 300, silence_duration_ms: 600 } }),
          input_audio_transcription: { language: AGENT_LANG }, // ancien schema, garde pour compatibilite
          audio: {
            input: {
              format: { type: "audio/pcm", rate: GROK_RATE },
              // Nouveau schema de transcription (Palazzo, 15/09/2026) : l'ancien ne rend plus que .completed.
              transcription: { model: "grok-transcribe", language_hint: AGENT_LANG },
              ...(TOURS_PAR_LE_PONT ? { turn_detection: null } : {}),
            },
            output: { format: { type: "audio/pcm", rate: GROK_RATE }, speed: GROK_SPEED },
          },
        },
      }));
    });

    grok.on("message", (raw) => {
      let e;
      try { e = JSON.parse(raw.toString()); } catch { return; }
      switch (e.type) {
        case "ping":
          grok.send(JSON.stringify({ type: "pong", ...(e.event_id ? { event_id: e.event_id } : {}) }));
          break;
        case "session.updated":
          if (!grokReady) {
            grokReady = true;
            if (TOURS_PAR_LE_PONT) marquerGeneration();
            grok.send(JSON.stringify({ type: "response.create" }));
          } // salut une fois
          break;
        case "response.created":
          if (TOURS_PAR_LE_PONT) { marquerGeneration(); reponseActive = true; }
          resteAudio = Buffer.alloc(0);
          audioReponseOctets = 0; debutReponseMs = Date.now(); premierSon = false;
          pushUser(); // le tour du client est fini, l'agent repond
          respSeq++;
          agentSpeaking = true; agentSpeakingSince = Date.now(); // Dany commence a parler -> on coupe l'ecoute (anti-echo)
          console.log(`[turn] ${AGENT_NAME} n°${respSeq} ${t()}`);
          break;
        case "response.output_audio.delta": {
          if (!e.delta || !streamSid || twilio.readyState !== WebSocket.OPEN) break;
          // Reponse coupee par le client : xAI ne sait pas annuler une reponse, donc la suite est jetee ici.
          if (respSeq === reponseCoupee) break;
          const brut = Buffer.concat([resteAudio, Buffer.from(e.delta, "base64")]);
          const pair = brut.length - (brut.length % 2);
          resteAudio = Buffer.from(brut.subarray(pair)); // 0 ou 1 octet
          if (pair === 0) break;
          const pcm = Buffer.from(brut.subarray(0, pair)); // copie : offset pair, sinon Int16Array leve
          const ulaw = pcm16ToUlaw8k(pcm, GROK_RATE);
          if (ulaw.length === 0) { mediasVides++; break; }
          twilio.send(JSON.stringify({ event: "media", streamSid, media: { payload: ulaw.toString("base64") } }));
          finLecture = Math.max(finLecture, Date.now()) + (ulaw.length / 8000) * 1000;
          audioReponseOctets += ulaw.length;
          if (!premierSon) {
            // LATENCE MESUREE : ce que l'appelant attend vraiment, depuis la fin de sa phrase.
            premierSon = true;
            if (accueilProtegeJusqua === Infinity) accueilProtegeJusqua = Date.now() + (respSeq === 1 ? ACCUEIL_PROTEGE_MS : 0);
            console.log(`[latence] n°${respSeq} premier son ${Date.now() - debutReponseMs} ms apres la creation${finParoleClientMs ? `, ${Date.now() - finParoleClientMs} ms apres la fin de parole du client` : ""} ${t()} sid=${callSid}`);
            finParoleClientMs = 0;
          }
          break;
        }
        case "response.output_audio_transcript.delta":
          if (e.delta) { agentBuf += e.delta; if (/remercie pour votre appel/i.test(agentBuf)) closingSaid = true; }
          break;
        case "response.done": {
          // JOURNAL PAR REPONSE : statut de Grok, secondes d'audio reellement envoyees a Twilio et duree de generation.
          // Un texte trop long pour sa duree d'audio (~17 car/s) trahit une reponse arretee net par Grok.
          const r = e.response || {};
          console.log(`[reponse] n°${respSeq} statut=${r.status || "?"}${r.status_details ? " " + JSON.stringify(r.status_details).slice(0, 200) : ""} audio=${(audioReponseOctets / 8000).toFixed(1)}s generee_en=${((Date.now() - debutReponseMs) / 1000).toFixed(1)}s texte=${agentBuf.length}car ${t()} sid=${callSid}`);
          if (TOURS_PAR_LE_PONT) { reponseActive = false; generation = false; lacherRetenue(); } // Grok peut de nouveau entendre le client
          pushAgent();
          // QUEUE DE SILENCE (Palazzo, 17/09/2026) : l'audio de Grok s'arrete sur la derniere syllabe, sans silence
          // apres, et la fin se perd sur le trajet telephonique. 300 ms de silence laissent a la ligne le temps de la jouer.
          if (streamSid && audioReponseOctets > 0 && respSeq !== reponseCoupee && twilio.readyState === WebSocket.OPEN) {
            const silence = Buffer.alloc(2400, 0xff); // mu-law 0xFF = zero, 300 ms a 8 kHz
            twilio.send(JSON.stringify({ event: "media", streamSid, media: { payload: silence.toString("base64") } }));
            finLecture = Math.max(finLecture, Date.now()) + 300;
          }
          // Dany a fini de GENERER, mais Twilio joue encore l'audio en file. On rouvre l'ecoute seulement au mark "agentdone"
          // (renvoye par Twilio quand la lecture est vraiment finie), pas maintenant, sinon on capte la fin de son propre audio.
          if (streamSid) twilio.send(JSON.stringify({ event: "mark", streamSid, mark: { name: `agentdone:${respSeq}` } }));
          if (TOURS_PAR_LE_PONT && tourEnAttente && !tour) { validerTour(); demanderReponse(); } // le client a parle pendant la generation
          if (closeTriggered && !endRequested) requestHangup("cloture polie");
          break;
        }
        case "conversation.item.input_audio_transcription.updated":
        case "conversation.item.input_audio_transcription.completed": // 15/09/2026 : xAI n'emet plus que .completed avec l'ancien schema ; sans lui, aucune ligne client et aucun recap
          setUser(e.transcript, false); // cumulatif ou final : remplace
          break;
        case "conversation.item.input_audio_transcription.delta":
          setUser(e.delta, true);
          break;
        case "input_audio_buffer.speech_started":
          if (TOURS_PAR_LE_PONT) break; // en mode manuel, Grok signale encore la parole : le pont a deja decide
          tourClient = { idx: null };
          lastCallerMs = Date.now();
          checkedIn = false; // le client reparle : on reinitialise la detection de silence
          finParoleClientMs = 0;
          parleSelonGrok = true;
          entenduSurAgent = false; coupeCeTour = false; voixMaxTour = 0;
          console.log(`[turn] client ${t()} voix_pont=${Math.round(voixRecenteMs)}ms`);
          verifierCoupure();
          break;
        case "input_audio_buffer.speech_stopped":
          if (TOURS_PAR_LE_PONT) break;
          finParoleClientMs = Date.now();
          parleSelonGrok = false;
          if (entenduSurAgent && !coupeCeTour) console.log(`[turn] son bref ignore (${Math.round(voixMaxTour)} ms de voix), l'agent finit sa phrase sid=${callSid}`);
          break;
        case "error":
          // Une erreur de Grok ne laissait aucune trace.
          console.error(`[grok] erreur ${JSON.stringify(e.error || e).slice(0, 300)} ${t()} sid=${callSid}`);
          // Une demande de reponse refusee ne doit pas laisser la voix du client retenue pour toujours.
          if (TOURS_PAR_LE_PONT && generation && !reponseActive) { generation = false; lacherRetenue(); }
          break;
        default:
          // Tout le reste une fois par appel, sauf ce qui peut expliquer une reponse perdue (annulation,
          // remplacement, tampon valide), journalise a chaque fois.
          if (/cancel|truncat|interrupt|commit|clear|fail|incomplete|delete/i.test(e.type) || !typesVus.has(e.type)) {
            typesVus.add(e.type);
            console.log(`[grok] ${e.type}${e.response?.id ? " " + e.response.id : ""}${e.item?.type ? " " + e.item.type : ""} ${t()}`);
          }
          break;
      }
    });

    grok.on("close", (code, raison) => {
      if (!finalized) console.error(`[grok] ws fermee en cours d'appel code=${code} ${String(raison || "").slice(0, 120)} sid=${callSid}`);
    });
    grok.on("error", (err) => console.error("[grok] ws error", err.message));
  }

  twilio.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.event === "start") {
      streamSid = m.start.streamSid;
      callSid = m.start.callSid;
      fromNumber = (m.start.customParameters && (m.start.customParameters.from || m.start.customParameters.From)) || null;
      console.log(`[call] start sid=${callSid} from=${fromNumber}`);
      openGrok();
    } else if (m.event === "media") {
      // Filet si le mark "agentdone" se perd : jamais tant que l'audio envoye n'a pas fini de jouer, et le silence
      // repart de la fin de lecture.
      if (agentSpeaking && Date.now() - agentSpeakingSince > AGENT_SPEAKING_MAX_MS && Date.now() > finLecture + 2000) { agentSpeaking = false; lastCallerMs = Math.max(Date.now(), finLecture); }
      const pcm = ulaw8kToPcm16(Buffer.from(m.media.payload, "base64"), GROK_RATE);
      const rms = rmsPcm16(pcm);
      const niveau = rms < 150 ? 0 : rms < 300 ? 1 : rms < 600 ? 2 : rms < 1200 ? 3 : rms < 2400 ? 4 : 5;
      sonHisto[niveau]++;
      const maintenant = Date.now();
      // DEMI-DUPLEX (sans BARGE_IN) : tant que l'agent est audible, de son premier son a la fin de lecture renvoyee
      // par Twilio, rien de ce qui arrive n'est ecoute. Sur haut-parleur, sa propre voix revient en echo et Grok la
      // prenait pour un tour du client : il enchainait ses questions sans attendre.
      const agentAudible = maintenant < finLecture || (agentSpeaking && audioReponseOctets > 0);
      const sourd = !BARGE_IN && agentAudible;
      if (agentAudible) sonHistoAgent[niveau]++;
      const paquetMs = (pcm.length / 2 / GROK_RATE) * 1000;
      if (TOURS_PAR_LE_PONT) {
        // Seuil de voix adapte a la ligne : deux fois le plancher de bruit des 5 dernieres secondes, borne entre
        // SEUIL_SON_RMS et 1200 (une voix basse au telephone reste au-dessus).
        niveaux[niveauxIdx] = rms;
        niveauxIdx = (niveauxIdx + 1) % niveaux.length;
        if (niveauxN < niveaux.length) niveauxN++;
        if (maintenant - seuilCalculeA > 500 && niveauxN >= 50) {
          const tri = Array.from(niveaux.subarray(0, niveauxN)).sort((x, y) => x - y);
          seuilVoix = Math.min(1200, Math.max(SEUIL_SON_RMS, tri[Math.floor(niveauxN * 0.1)] * 2));
          if (seuilVoix > seuilMax) seuilMax = seuilVoix;
          seuilCalculeA = maintenant;
        }
      }
      const voix = !sourd && rms >= (TOURS_PAR_LE_PONT ? seuilVoix : SEUIL_SON_RMS);
      const voixMs = voix ? paquetMs : 0;
      voixRecenteMs += voixMs - voixFenetre[voixFenetreIdx];
      voixFenetre[voixFenetreIdx] = voixMs;
      voixFenetreIdx = (voixFenetreIdx + 1) % voixFenetre.length;
      if (TOURS_PAR_LE_PONT) {
        // Seules les prises de parole partent a Grok (300 ms avant, FIN_DE_TOUR_MS de silence apres) : son tampon ne
        // contient que ce que le client a dit, et un son ignore s'efface sans rien laisser.
        if (voix) {
          if (!tour) {
            tour = { debut: maintenant, voixMs: 0, derniereVoix: maintenant, coupe: false };
            lastCallerMs = maintenant;
            // Les transcriptions en direct de cette prise de parole ne doivent pas reecrire la ligne du tour precedent.
            if (tourClient && tourClient.idx != null) tourClient = null;
            envoyerAGrok(preroll.splice(0));
          }
          tour.voixMs += paquetMs;
          tour.derniereVoix = maintenant;
        }
        if (tour) {
          if (!sourd) envoyerAGrok([pcm]);
          verifierCoupure();
          if (tour && ((!voix && maintenant - tour.derniereVoix >= FIN_DE_TOUR_MS) || maintenant - tour.debut > TOUR_MAX_MS)) finDuTour();
        } else if (sourd) {
          preroll.length = 0; // l'echo de l'agent ne doit pas preceder la prochaine prise de parole
        } else {
          preroll.push(pcm);
          if (preroll.length > PREROLL_PAQUETS) preroll.shift();
        }
      } else {
        verifierCoupure();
        if (grok && grok.readyState === WebSocket.OPEN && grokReady && (BARGE_IN || !agentSpeaking)) {
          grok.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
        }
      }
    } else if (m.event === "mark") {
      if (m.mark && m.mark.name === "hangup") { try { twilio.close(); } catch {} }
      else if (m.mark && /^agentdone(:|$)/.test(m.mark.name) && (m.mark.name === "agentdone" || Number(m.mark.name.split(":")[1]) === respSeq)) { agentSpeaking = false; lastCallerMs = Date.now(); console.log(`[turn] lecture finie ${m.mark.name} ${t()} sid=${callSid}`); } // Dany a fini de parler (audio joue) : on rouvre l'ecoute + on relance le compte a rebours du silence. Le mark d'une reponse anterieure est ignore.
    } else if (m.event === "stop") {
      finalize();
    }
  });
  twilio.on("close", (code, raison) => {
    console.log(`[twilio] flux ferme code=${code} ${String(raison || "").slice(0, 120)} medias_vides_evites=${mediasVides} sid=${callSid}`);
    finalize();
  });
  twilio.on("error", (err) => { console.error("[twilio] ws error", err.message); finalize(); });

  // Filet anti-credits : si le client se tait apres la cloture (8s) ou reste inactif longtemps (30s),
  // on raccroche, au cas ou l'agent n'aurait pas appele end_call.
  // Fait parler Dany via une instruction systeme injectee (check-in ou conge).
  function promptGrok(text) {
    try {
      grok.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } }));
      if (TOURS_PAR_LE_PONT) marquerGeneration();
      grok.send(JSON.stringify({ type: "response.create" }));
    } catch {}
  }

  // Gestion du silence : 1) "vous etes toujours la ?" ; 2) si toujours silence, conge poli puis raccroche.
  const inactivityTimer = setInterval(() => {
    // Filet : une reponse demandee qui ne vient jamais (8 s) ou qui ne se termine jamais (30 s) ne doit pas
    // garder la voix du client retenue ; Grok a deja abandonne des reponses sans response.done.
    if (TOURS_PAR_LE_PONT && generation && !finalized) {
      const depuis = Date.now() - generationDemandeeA;
      if ((!reponseActive && depuis > 8000) || depuis > 30000) {
        console.log(`[tour] reponse jamais terminee (${Math.round(depuis / 1000)} s), la voix du client repart ${t()} sid=${callSid}`);
        generation = false; reponseActive = false;
        lacherRetenue();
        if (tourEnAttente && !tour) { validerTour(); demanderReponse(); }
      }
    }
    if (finalized || endRequested) return;
    if (!(grok && grok.readyState === WebSocket.OPEN && grokReady)) return;
    if (TOURS_PAR_LE_PONT && (generation || tour || tourEnAttente)) return; // l'appel n'est pas silencieux
    // L'agent parle encore (reponse en cours ou audio encore en file chez Twilio) : ce n'est pas un silence du client.
    if (Date.now() < finLecture || (agentSpeaking && Date.now() - agentSpeakingSince < AGENT_SPEAKING_MAX_MS)) return;
    const idle = Date.now() - Math.max(lastCallerMs, finLecture);
    if (closingSaid && idle > 8000) { requestHangup("cloture+silence"); return; }
    if (closeTriggered) { if (idle > 25000) requestHangup("inactivite"); return; } // conge en cours, backstop
    if (idle > 15000) {
      lastCallerMs = Date.now();
      if (!checkedIn) {
        checkedIn = true;
        promptGrok("(SYSTEME : le client est silencieux. Demande-lui brievement s'il est toujours la, par exemple 'Allo, vous etes toujours la ?', et rien d'autre.)");
      } else {
        closeTriggered = true;
        promptGrok("(SYSTEME : le client ne repond toujours pas. Dis une breve phrase de conge polie qui remercie pour l'appel et souhaite une bonne journee, et rien d'autre.)");
      }
    }
  }, 2000);

  async function finalize() {
    if (finalized) return;
    finalized = true;
    clearInterval(inactivityTimer);
    pushUser();
    pushAgent();
    try { if (grok && grok.readyState === WebSocket.OPEN) grok.close(); } catch {}
    const lignes = dialog.filter((l) => String(l.msg || "").trim()); // une place reservee a une transcription jamais arrivee reste vide
    const text = lignes.map((l) => `${l.who} : ${l.msg}`).join("\n");
    console.log(`[call] stop sid=${callSid} lignes=${lignes.length}`);
    // Niveaux de la voix du client sur tout l'appel (paquets de 20 ms) : ce qui sert a regler SEUIL_SON_RMS
    // d'apres de vraies lignes. La colonne pendant_agent montre l'echo.
    console.log(`[son] rms <150:${sonHisto[0]} <300:${sonHisto[1]} <600:${sonHisto[2]} <1200:${sonHisto[3]} <2400:${sonHisto[4]} >=2400:${sonHisto[5]} pendant_agent=${sonHistoAgent.join("/")} seuil=${SEUIL_SON_RMS}${TOURS_PAR_LE_PONT ? ` seuil_max=${Math.round(seuilMax)} tours=${toursValides} ignores=${toursIgnores}` : ""} sid=${callSid}`);
    if (lignes.length) pushCall({ ts: new Date().toISOString(), from: fromNumber, sid: callSid, endReason, dialog: text });
    const hasClient = lignes.some((l) => l.who === "Client");
    if (hasClient && RECAP_EXCLURE.has(String(fromNumber || "").replace(/[^\d+]/g, ""))) {
      console.log(`[recap] numero de test ${fromNumber}, pas de recap sid=${callSid}`);
    } else if (hasClient && N8N_RECAP_URL) {
      const payload = { dialog: text, phone: fromNumber || "inconnu", call_sid: callSid };
      const ok = await postRecap(payload, 4); // essais immediats au raccrochage : 1s, 2s, 4s, 8s
      if (ok) console.log(`[recap] envoye a n8n sid=${callSid}`);
      else { pendingRecaps.push(payload); console.error(`[recap] n8n injoignable, mis en file de reessai sid=${callSid}`); }
    } else if (!hasClient) {
      console.log(`[call] raccroche sans parole, pas de recap sid=${callSid}`);
    }
  }
});

server.listen(PORT, () => console.log(`[boot] voice-reception-bridge sur :${PORT} (rate Grok ${GROK_RATE}, tours ${TOURS_PAR_LE_PONT ? "pont" : "grok"}, coupure ${BARGE_IN ? "oui" : "non"})`));
