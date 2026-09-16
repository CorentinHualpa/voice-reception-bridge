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
//   PROMPT_FILE        fichier du prompt (si RECEPTION_PROMPT absent). {{CARTE}} y est remplace par la carte.
//   CLOSING_REGEX      phrase de cloture qui arme le raccrochage (defaut "remercie pour votre appel")
//   AGENT_TOOLS        "pizzeria" active les outils de prise de commande (voir lib/pizzeria.js)
//   MENU_FILE, DATA_FILE, CAPACITE_PAR_QUART, RESERVE_PAR_QUART, DELAI_MIN_MINUTES,
//   MAX_PIZZAS, SERVICES, TIME_ZONE   reglages du profil pizzeria
//   PORT               injecte par Railway

import http from "http";
import fs from "fs";
import { WebSocketServer, WebSocket } from "ws";
import { ulaw8kToPcm16, pcm16ToUlaw8k } from "./lib/audio.js";
import { createPizzeria } from "./lib/pizzeria.js";
import {
  chargerSession,
  dalevozActif,
  enregistrerAppel,
  executerOutil,
  resoudreNumero,
  signatureTwilioValide,
} from "./lib/dalevoz.js";

const PORT = process.env.PORT || 8080;
const XAI_API_KEY = process.env.XAI_API_KEY;
const GROK_MODEL = process.env.GROK_MODEL || "grok-voice-latest";
const GROK_VOICE = process.env.GROK_VOICE || "eve";
const GROK_RATE = Number(process.env.GROK_RATE || 8000);
const GROK_SPEED = Number(process.env.GROK_SPEED || 1.0);          // vitesse de parole (0.7..1.5)
const GROK_VAD_THRESHOLD = Number(process.env.GROK_VAD_THRESHOLD || 0.6); // reactivite VAD (0.1..0.9 ; plus bas = plus sensible)
const GROK_REASONING = process.env.GROK_REASONING || "high";       // "high" = profond, "none" = rapide
const AGENT_LANG = process.env.AGENT_LANG || "fr";
const AGENT_NAME = process.env.AGENT_NAME || "Dany";
const BUSINESS_NAME = process.env.BUSINESS_NAME || "l'entreprise";
const BUSINESS_DESC = process.env.BUSINESS_DESC || "";
const N8N_RECAP_URL = process.env.N8N_RECAP_URL || "";
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // protege le tableau de bord /admin
const CLOSING_RE = new RegExp(process.env.CLOSING_REGEX || "remercie pour votre appel", "i");
const AGENT_SPEAKING_MAX_MS = Number(process.env.AGENT_SPEAKING_MAX_MS || 12000); // filet anti-surdite si le mark de fin de parole se perd ; un recapitulatif de commande depasse 12 s
const MAX_RELANCES_OUTILS = 4;
const BARGE_IN = process.env.BARGE_IN === "1"; // le client peut couper la parole a l'agent (voir le handler media)
// Phrase de recapitulatif qui appelle un oui du client (sinon : une reponse qui cite des euros et pose une question).
const RECAP_RE = /c'est bien ça|c'est correct|est-ce (bien )?(correct|ça)|je récapitule|récapitul|ça vous va|is that (right|correct)|does that sound|es correcto|está bien así|è corretto|va bene così/i; // relances apres outil par tour client : au-dela, l'agent s'enchaine tout seul

if (!XAI_API_KEY) console.error("[boot] ATTENTION: XAI_API_KEY manquante");

const pizzeria = process.env.AGENT_TOOLS === "pizzeria"
  ? createPizzeria({
      menuFile: process.env.MENU_FILE || "menus/palazzo.json",
      dataFile: process.env.DATA_FILE || "",
      capaciteParQuart: Number(process.env.CAPACITE_PAR_QUART || 15),
      reserveParQuart: Number(process.env.RESERVE_PAR_QUART || 0),
      delaiMinMinutes: Number(process.env.DELAI_MIN_MINUTES || 20),
      maxPizzas: Number(process.env.MAX_PIZZAS || 20),
      services: process.env.SERVICES || "11:30-14:30,18:30-22:30",
      timeZone: process.env.TIME_ZONE || "Europe/Paris",
    })
  : null;

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
const PROMPT_FROM_FILE = process.env.PROMPT_FILE
  ? fs.readFileSync(process.env.PROMPT_FILE, "utf8").replace("{{CARTE}}", pizzeria ? pizzeria.carteTexte() : "")
  : "";
const RECEPTION_PROMPT = process.env.RECEPTION_PROMPT || PROMPT_FROM_FILE || `Tu es ${AGENT_NAME}, l'assistant vocal telephonique de ${BUSINESS_NAME}${BUSINESS_DESC ? " (" + BUSINESS_DESC + ")" : ""}. Tu decroches quand le standard est ferme (hors horaires). Tu vouvoies, tu es chaleureux, calme et clair, une idee par phrase, une seule question a la fois.

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

function renderCommandes() {
  if (!pizzeria) return "";
  const euros = (x) => (x == null ? "?" : x.toFixed(2).replace(".", ",") + " €");
  const cmds = pizzeria.commandes().map((c) => `<div style="border:1px solid #e5e7eb;border-radius:10px;padding:12px 16px;margin:10px 0;background:#fff">
      <div style="font-weight:600">N° ${escHtml(c.numero)} &middot; ${escHtml(c.prenom)} &middot; retrait ${escHtml(c.jour)} à ${escHtml(c.heure_retrait)} &middot; ${euros(c.total_eur)}</div>
      <div style="font-size:12px;color:#4b5563;margin:2px 0 6px">prise le ${escHtml(c.ts)} &middot; ${escHtml(c.telephone || "numéro inconnu")}</div>
      ${c.lignes.map((l) => `<div style="font-size:14px">${l.quantite} × ${escHtml(l.produit)}${l.supplements.length ? " + " + escHtml(l.supplements.join(", ")) : ""}${l.retraits.length ? " sans " + escHtml(l.retraits.join(", ")) : ""}${l.remarque ? " (" + escHtml(l.remarque) + ")" : ""} &middot; ${euros(l.sous_total_eur)}</div>`).join("")}
      ${c.remarque ? `<div style="font-size:13px;margin-top:4px">Remarque : ${escHtml(c.remarque)}</div>` : ""}
    </div>`).join("") || '<p style="color:#4b5563">Aucune commande.</p>';
  const msgs = pizzeria.messages().map((m) => `<div style="border:1px solid #fde68a;border-radius:10px;padding:10px 16px;margin:8px 0;background:#fffbeb">
      <div style="font-weight:600">${escHtml(m.motif)} &middot; ${escHtml(m.prenom || "sans prénom")} &middot; ${escHtml(m.telephone || "numéro inconnu")}</div>
      <div style="font-size:12px;color:#4b5563">${escHtml(m.ts)}</div>
      ${m.details ? `<div style="font-size:14px;margin-top:4px">${escHtml(m.details)}</div>` : ""}
    </div>`).join("") || '<p style="color:#4b5563">Aucun message.</p>';
  return `<h2 style="font-size:16px;margin:0 0 4px">Commandes</h2>${cmds}
    <h2 style="font-size:16px;margin:18px 0 4px">Messages à rappeler</h2>${msgs}<div style="height:18px"></div>`;
}

function renderDashboard() {
  const cfg = `voix ${GROK_VOICE} · vitesse ${GROK_SPEED} · VAD ${GROK_VAD_THRESHOLD} · raisonnement ${GROK_REASONING} · rate ${GROK_RATE} · langue ${AGENT_LANG}`;
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
    ${renderCommandes()}
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
    // On injecte le numero appelant (From), le numero appele (To) et le CallSid :
    // le pont resout ensuite l'agent Dale Voz a partir du numero appele.
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const post = Object.fromEntries(new URLSearchParams(body));
      const query = new URL(req.url, "http://x").searchParams;
      const propre = (v) => String(v || "").replace(/[<>&"']/g, "");
      const from = propre(post.From || query.get("From"));
      const to = propre(post.To || query.get("To"));
      const callSid = propre(post.CallSid || query.get("CallSid"));
      const host = req.headers.host;

      // Numero rattache a un agent Dale Voz : on verifie que l'appel vient bien
      // de Twilio avant de decrocher. L'adresse du webhook est publique, sans
      // cette verification n'importe qui ferait parler l'agent d'un client.
      let tenantId = "";
      if (dalevozActif && to) {
        const r = await resoudreNumero(to);
        if (r.inconnu) {
          console.error(`[twiml] numero inconnu ${to}`);
          res.writeHead(404, { "Content-Type": "text/xml" });
          res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Say language="fr-FR">Ce numéro n'est pas configuré.</Say><Hangup/></Response>`);
          return;
        }
        // Plateforme injoignable : on decroche quand meme, sur la config locale.
        // Une panne de la console ne doit pas faire taire les numeros branches.
        if (r.canal) {
          const urlComplete = `https://${host}${req.url}`;
          const signature = req.headers["x-twilio-signature"] || "";
          if (!signatureTwilioValide({ authToken: r.canal.authToken, url: urlComplete, params: post, signature })) {
            console.error(`[twiml] signature Twilio refusee sid=${callSid} to=${to}`);
            res.writeHead(403, { "Content-Type": "text/plain" });
            res.end("signature invalide");
            return;
          }
          tenantId = r.canal.tenantId;
        } else {
          console.error(`[twiml] plateforme injoignable, repli sur la config locale to=${to}`);
        }
      }

      const params = [
        `<Parameter name="from" value="${from}"/>`,
        to ? `<Parameter name="to" value="${to}"/>` : "",
        callSid ? `<Parameter name="callSid" value="${callSid}"/>` : "",
      ].join("");
      const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://${host}/twilio">${params}</Stream></Connect></Response>`;
      if (tenantId) console.log(`[twiml] appel accepte to=${to} sid=${callSid}`);
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
  let toNumber = null;    // numero APPELE : c'est lui qui designe l'agent Dale Voz
  let canalDV = null;     // { tenantId, agentSlug, locale... } quand le numero est rattache
  let sessionDV = null;   // instructions, voix et outils de la version publiee de l'agent
  let sessionIdDV = null; // fil Dale Voz, cree a l'ecriture de l'appel
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
  let greetRetry = 0;
  let lastCallerMs = Date.now();
  let pendingCalls = [];   // appels d'outils de la reponse en cours, traites en response.done
  let relancesOutils = 0;  // relances apres outil depuis le dernier tour client
  let clotureVerifiee = false; // garde « commande annoncee sans enregistrement » : une seule consigne par appel
  let recapTs = 0, clientApresRecap = false; // garde « pas d'enregistrement sans recapitulatif suivi d'une reponse du client »
  let respSeq = 0;         // numero de la reponse en cours : le mark "agentdone" d'une reponse finie ne doit pas rouvrir l'ecoute pendant la suivante
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
  let tourClient = null; // { idx } depuis le dernier speech_started
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
    // L'agent joué vient de Dale Voz quand le numéro appelé y est rattaché ;
    // sinon le pont garde sa configuration locale (prompt en fichier), ce qui
    // fait tourner Motralec et Palazzo tant que leur numéro n'est pas branché.
    if (dalevozActif && toNumber) {
      canalDV = (await resoudreNumero(toNumber)).canal ?? null;
      if (canalDV) {
        sessionDV = await chargerSession({
          tenantId: canalDV.tenantId,
          agentSlug: canalDV.agentSlug,
          locale: canalDV.locale,
        });
        if (!sessionDV) console.error(`[dalevoz] config introuvable pour ${canalDV.agentSlug}, repli sur la config locale`);
        else console.log(`[dalevoz] agent ${canalDV.agentSlug} (${sessionDV.tools?.length ?? 0} outils) pour ${toNumber}`);
      }
    }
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
        pizzeria ? pizzeria.contexteAppel() : "",
        callerFr ? `Le client appelle depuis le numéro ${callerFr}. Quand tu lui relis ce numéro à voix, tu prononces EXACTEMENT ceci, mot pour mot, sans le recalculer ni changer un seul groupe : « ${callerSpoken} ». C'est son numéro de rappel par défaut, tu le connais déjà.` : "",
      ].filter(Boolean).join("\n");
      const instructionsBase = sessionDV?.instructions || RECEPTION_PROMPT;
      const sessionInstructions = contexte ? `${instructionsBase}\n\n# Contexte de cet appel\n${contexte}` : instructionsBase;
      const outils = [...(pizzeria ? pizzeria.tools : []), ...(sessionDV?.tools ?? [])];
      grok.send(JSON.stringify({
        type: "session.update",
        session: {
          instructions: sessionInstructions,
          ...(outils.length ? { tools: outils, tool_choice: "auto" } : {}),
          voice: sessionDV?.voice || GROK_VOICE,
          reasoning: { effort: GROK_REASONING },
          turn_detection: { type: "server_vad", threshold: GROK_VAD_THRESHOLD, prefix_padding_ms: 300, silence_duration_ms: 600 },
          input_audio_transcription: { language: AGENT_LANG }, // ancien schema, ignore en silence par xAI : garde pour compatibilite
          audio: {
            input: { format: { type: "audio/pcm", rate: GROK_RATE }, transcription: { model: "grok-transcribe", language_hint: AGENT_LANG } },
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
          if (!grokReady) { grokReady = true; grok.send(JSON.stringify({ type: "response.create" })); } // salut une fois
          break;
        case "response.created":
          pushUser(); // le tour du client est fini, l'agent repond
          respSeq++;
          agentSpeaking = true; agentSpeakingSince = Date.now(); // Dany commence a parler -> on coupe l'ecoute (anti-echo)
          console.log("[turn] Dany");
          break;
        case "response.function_call_arguments.done":
          pendingCalls.push({ name: e.name, callId: e.call_id, args: e.arguments });
          break;
        case "response.output_audio.delta": {
          if (!e.delta || !streamSid) break;
          const pcm = Buffer.from(e.delta, "base64");
          const ulaw = pcm16ToUlaw8k(pcm, GROK_RATE);
          twilio.send(JSON.stringify({ event: "media", streamSid, media: { payload: ulaw.toString("base64") } }));
          break;
        }
        case "response.output_audio_transcript.delta":
          if (e.delta) { agentBuf += e.delta; if (CLOSING_RE.test(agentBuf)) closingSaid = true; }
          break;
        case "response.done": {
          const texteReponse = agentBuf;
          pushAgent();
          if (RECAP_RE.test(texteReponse) || (/euro/i.test(texteReponse) && /\?/.test(texteReponse))) { recapTs = Date.now(); clientApresRecap = false; }
          // Dany a fini de GENERER, mais Twilio joue encore l'audio en file. On rouvre l'ecoute seulement au mark "agentdone"
          // (renvoye par Twilio quand la lecture est vraiment finie), pas maintenant, sinon on capte la fin de son propre audio.
          if (streamSid) twilio.send(JSON.stringify({ event: "mark", streamSid, mark: { name: `agentdone:${respSeq}` } }));
          const calls = pendingCalls.splice(0);
          if (calls.length) runTools(calls).catch((err) => console.error("[outil] echec du cycle", err));
          else if (pizzeria && !clotureVerifiee) {
            const consigne = pizzeria.consigneCloture(texteReponse, { callSid, outils: calls.map((c) => c.name) });
            if (consigne) {
              clotureVerifiee = true; closingSaid = false;
              console.log(`[garde] commande annoncee sans enregistrement sid=${callSid}`);
              dialog.push({ who: "Garde", msg: "commande annoncée sans enregistrement, consigne renvoyée" });
              promptGrok(consigne);
            }
          }
          if (closeTriggered && !endRequested) requestHangup("cloture polie");
          break;
        }
        case "conversation.item.input_audio_transcription.updated":
        case "conversation.item.input_audio_transcription.completed":
          setUser(e.transcript, false); // cumulatif ou final : remplace
          break;
        case "conversation.item.input_audio_transcription.delta":
          setUser(e.delta, true);
          break;
        case "input_audio_buffer.speech_started":
          tourClient = { idx: null };
          if (recapTs) clientApresRecap = true;
          lastCallerMs = Date.now();
          relancesOutils = 0;
          checkedIn = false; // le client reparle : on reinitialise la detection de silence
          console.log("[turn] client");
          if (streamSid) twilio.send(JSON.stringify({ event: "clear", streamSid })); // barge-in : vider la file Twilio
          if (BARGE_IN && agentSpeaking) {
            // Couper la reponse en cours cote Grok, pas seulement l'audio deja en file chez
            // Twilio : sinon il continue de generer et la suite arrive apres la question du
            // client. « no active response » en retour est benin (la reponse etait finie).
            try { grok.send(JSON.stringify({ type: "response.cancel" })); } catch {}
            pushAgent();
            agentSpeaking = false;
            console.log(`[turn] client coupe l'agent sid=${callSid}`);
          }
          break;
      }
    });

    grok.on("close", () => {});
    grok.on("error", (err) => console.error("[grok] ws error", err.message));
  }

  twilio.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.event === "start") {
      streamSid = m.start.streamSid;
      callSid = m.start.callSid;
      fromNumber = (m.start.customParameters && (m.start.customParameters.from || m.start.customParameters.From)) || null;
      toNumber = (m.start.customParameters && (m.start.customParameters.to || m.start.customParameters.To)) || null;
      console.log(`[call] start sid=${callSid} from=${fromNumber} to=${toNumber}`);
      openGrok();
    } else if (m.event === "media") {
      if (agentSpeaking && Date.now() - agentSpeakingSince > AGENT_SPEAKING_MAX_MS) { agentSpeaking = false; lastCallerMs = Date.now(); } // filet si le mark "agentdone" se perd
      // BARGE_IN=1 : la voix du client part TOUJOURS a Grok, meme pendant que l'agent parle,
      // et un debut de parole coupe la reponse en cours. Sans lui (Motralec), le demi-duplex
      // reste : on n'ecoute pas tant que Twilio n'a pas fini de lire, et le client ne peut
      // pas interrompre. Constate le 16/09/2026 sur Palazzo : l'agent lit la carte et
      // relance apres chaque outil, le client reste sourd jusqu'a 25 s et n'arrive pas a
      // l'arreter. L'echo qui avait motive le demi-duplex venait d'un haut-parleur ; un
      // combine n'en produit pas, et une fausse coupure coute moins qu'un agent qu'on ne
      // peut pas faire taire.
      if (grok && grok.readyState === WebSocket.OPEN && grokReady && (BARGE_IN || !agentSpeaking)) {
        const pcm = ulaw8kToPcm16(Buffer.from(m.media.payload, "base64"), GROK_RATE);
        grok.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
      }
    } else if (m.event === "mark") {
      if (m.mark && m.mark.name === "hangup") { try { twilio.close(); } catch {} }
      else if (m.mark && /^agentdone(:|$)/.test(m.mark.name) && (m.mark.name === "agentdone" || Number(m.mark.name.split(":")[1]) === respSeq)) { agentSpeaking = false; lastCallerMs = Date.now(); } // Dany a fini de parler (audio joue) : on rouvre l'ecoute + on relance le compte a rebours du silence. Le mark d'une reponse anterieure (outil suivi d'une relance) est ignore.
    } else if (m.event === "stop") {
      finalize();
    }
  });
  twilio.on("close", finalize);
  twilio.on("error", (err) => { console.error("[twilio] ws error", err.message); finalize(); });

  // Filet anti-credits : si le client se tait apres la cloture (8s) ou reste inactif longtemps (30s),
  // on raccroche, au cas ou l'agent n'aurait pas appele end_call.
  // Fait parler Dany via une instruction systeme injectee (check-in ou conge).
  function promptGrok(text) {
    try {
      grok.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } }));
      grok.send(JSON.stringify({ type: "response.create" }));
    } catch {}
  }

  // Outils : un appel d'outil termine la reponse du modele. On renvoie le resultat PUIS on relance,
  // sinon il reste muet. Plafond de relances par tour client, sinon il s'enchaine tout seul.
  const outilLocal = (nom) => Boolean(pizzeria) && pizzeria.tools.some((t) => t.name === nom);

  async function runTools(calls) {
    if (!(grok && grok.readyState === WebSocket.OPEN)) return;
    for (const c of calls) {
      let args = {};
      try { args = JSON.parse(c.args || "{}"); } catch {}
      let out;
      if (c.name === "end_call") {
        // Outil de Dale Voz : cote web la surface raccroche, ici c'est Twilio.
        out = { ok: true };
        setTimeout(() => requestHangup("end_call"), 1500);
      } else if (outilLocal(c.name)) {
        if (c.name === "chiffrer_commande") { recapTs = 0; clientApresRecap = false; } // commande modifiee : nouveau recapitulatif exige
        try { out = pizzeria.run(c.name, args, { callSid, from: frPhone(fromNumber), recapConfirme: recapTs > 0 && clientApresRecap }); }
        catch (err) { out = { ok: false, erreur: err.message }; console.error(`[outil] ${c.name} KO`, err); }
      } else if (canalDV) {
        const reponse = await executerOutil({
          tenantId: canalDV.tenantId,
          agentSlug: canalDV.agentSlug,
          outil: c.name,
          args,
          sessionId: sessionIdDV,
          locale: canalDV.locale,
        });
        // La plateforme renvoie { output } deja serialise ; null = elle n'a pas repondu.
        out = reponse?.output ?? { ok: false, erreur: "outil indisponible" };
      } else {
        out = { ok: false, erreur: `outil inconnu ${c.name}` };
      }
      const sortie = typeof out === "string" ? out : JSON.stringify(out);
      console.log(`[outil] ${c.name} ${JSON.stringify(args)} -> ${sortie.slice(0, 300)}`);
      dialog.push({ who: "Outil", msg: `${c.name} ${JSON.stringify(args)} -> ${sortie}` });
      if (!(grok && grok.readyState === WebSocket.OPEN)) return;
      grok.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: c.callId, output: sortie } }));
    }
    if (relancesOutils < MAX_RELANCES_OUTILS) { relancesOutils++; grok.send(JSON.stringify({ type: "response.create" })); }
    else console.log(`[outil] plafond de relances atteint sid=${callSid}`);
  }

  // Gestion du silence : 1) "vous etes toujours la ?" ; 2) si toujours silence, conge poli puis raccroche.
  const inactivityTimer = setInterval(() => {
    if (finalized || endRequested) return;
    if (!(grok && grok.readyState === WebSocket.OPEN && grokReady)) return;
    const idle = Date.now() - lastCallerMs;
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
    if (lignes.length) pushCall({ ts: new Date().toISOString(), from: fromNumber, sid: callSid, endReason, dialog: text });
    const hasClient = lignes.some((l) => l.who === "Client");

    // Dale Voz : l'appel entre dans Conversations et la minute est comptee.
    // Les lignes d'outil ne sont pas du dialogue, elles restent dans le journal du pont.
    if (canalDV) {
      const tours = lignes
        .filter((l) => l.who === "Client" || l.who === "Agent")
        .map((l) => ({ role: l.who === "Client" ? "user" : "assistant", text: l.msg }));
      const ecrit = await enregistrerAppel({
        tenantId: canalDV.tenantId,
        agentSlug: canalDV.agentSlug,
        turns: tours,
        appelId: callSid,
        dureeMs: Date.now() - debutAppelMs,
        userId: frPhone(fromNumber) || undefined,
        locale: canalDV.locale,
        diagnostic: endReason,
      });
      sessionIdDV = ecrit?.sessionId ?? null;
      console.log(`[dalevoz] appel ${sessionIdDV ? "ecrit " + sessionIdDV : "NON ecrit"} sid=${callSid}`);
    }
    if (hasClient && N8N_RECAP_URL) {
      const payload = { dialog: text, phone: fromNumber || "inconnu", call_sid: callSid };
      const ok = await postRecap(payload, 4); // essais immediats au raccrochage : 1s, 2s, 4s, 8s
      if (ok) console.log(`[recap] envoye a n8n sid=${callSid}`);
      else { pendingRecaps.push(payload); console.error(`[recap] n8n injoignable, mis en file de reessai sid=${callSid}`); }
    } else if (!hasClient) {
      console.log(`[call] raccroche sans parole, pas de recap sid=${callSid}`);
    }
  }
});

server.listen(PORT, () => console.log(`[boot] voice-reception-bridge sur :${PORT} (rate Grok ${GROK_RATE})`));
