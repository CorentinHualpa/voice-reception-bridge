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
import { ulaw8kToPcm16, pcm16ToUlaw8k, ulawDecodeSample, ulawEncodeSample } from "./lib/audio.js";

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
// LATENCE, portee de palazzo-v1 le 17/09/2026 (chantier Palazzo, appels reels et bancs, doctrine : skill agent-voice,
// references/telephony-reception.md § 7 bis points 4 a 7).
// REPONSE ANTICIPEE : un tour coutait l'attente de fin de phrase (FIN_DE_TOUR_MS) PUIS ~0,7 s de Grok. Des
// ANTICIPATION_MS de silence, le pont valide deja la phrase et Grok genere ; le son n'est lache qu'a la fin du tour,
// donc la fin de phrase n'est pas plus courte (un nom epele garde sa tolerance). Si le client reprend avant, la reponse
// est annulee (response.cancel) et effacee (conversation.item.delete), et la suite de la phrase part a Grok : son
// message du client reste ouvert apres un commit et la suite s'y ajoute. L'effacer puis renvoyer toute la phrase la
// doublait chez le modele. ANTICIPATION_MS=0 remet l'ancien fonctionnement sans toucher au code.
const ANTICIPATION_MS = Number(process.env.ANTICIPATION_MS ?? 400);
const ANNULATION_VOIX_MS = 150; // voix du client apres le lancement qui annule l'anticipation (le seuil d'un son ignore)
// REPONSE JAMAIS CREEE : un tour valide sans mot reconnaissable (« euh », « mmm ») ne cree aucun message chez Grok, qui
// ignore alors response.create EN SILENCE (ni response.created ni erreur). Le filet attendait 8 s. En mode manuel,
// response.created arrive 90 a 180 ms apres le commit : au-dela de REPONSE_IGNOREE_MS, la demande est perdue.
const REPONSE_IGNOREE_MS = Number(process.env.REPONSE_IGNOREE_MS || 1000);
// « MMM » D'ATTENTE : une reponse sur cinq, Grok met 2,7 a 3,7 s a parler (cote xAI). Quand rien n'est encore joue
// MMM_APRES_MS apres la fin de phrase du client, qu'une reponse est en route et qu'elle est muette depuis
// MMM_CREEE_DEPUIS_MS apres sa creation (signe d'un blocage, pas d'un son imminent), l'agent fait « Mmm… » dans sa
// propre voix (Grok TTS, mu-law 8 kHz, produit une fois par voix). Une fois par tour. MMM_APRES_MS=0 le coupe.
// ⚠ COUPE PAR DEFAUT pour Dany (0) : en demi-duplex, l'agent n'ecoute pas pendant son « Mmm », et au banc du 17/09
// (4 blocages de Grok dans l'appel) l'appelant qui parlait juste apres le « Mmm », dans le blanc qui suit, a fait deux
// tours parasites (« Hm. » → « Pardon, je n'ai pas bien saisi »). Sans lui, meme appel propre. MMM_APRES_MS=2400 l'active.
const MMM_APRES_MS = Number(process.env.MMM_APRES_MS ?? 0);
const MMM_CREEE_DEPUIS_MS = Number(process.env.MMM_CREEE_DEPUIS_MS || 1300);
const MMM_TEXTE = process.env.MMM_TEXTE || "Mmm…";
// FINS DE PHRASE AVALEES (diagnostic du 17/09/2026 sur Palazzo, porte ici a la demande de Coq ; appel de controle de
// Dany a 16:22 UTC : « …ou préférez-vous un autre numéro » coupe). Grok lache le dernier signe d'une reponse, et la fin
// de la derniere syllabe avec, quand ce signe est un « ? » PRECEDE D'UNE ESPACE, comme le veut la typographie
// francaise : « Très bien. C'est pour quel prénom ? » s'entend « …pour quel prix ? » 3 fois sur 3, « prénom? » jamais.
// Ni le format audio, ni la vitesse, ni la ligne : aucun son n'arrive apres response.done. Le modele imite la
// typographie de sa consigne : on retire ces espaces de tout ce qui lui est envoye et on lui demande de coller le « ? ».
// TYPO_COLLEE=0 remet le texte tel quel.
const TYPO_COLLEE = process.env.TYPO_COLLEE !== "0";
const collerPonctuation = (s) => (TYPO_COLLEE && typeof s === "string" ? s.replace(/[   ]+([?!;:])/g, "$1") : s);
const CONSIGNE_PONCTUATION = "Écriture de tes réponses : le point d'interrogation et le point d'exclamation se collent au mot qui précède, sans espace avant (« C'est bien ça? », « Parfait! »). Jamais « ça ? » : au téléphone, cette espace fait avaler la fin de ta phrase.";
const sonsDAttente = new Map(); // "voix|vitesse|texte" -> Promise<Buffer mu-law | null>
function sonDAttente(voix, vitesse) {
  const cle = `${voix}|${vitesse}|${MMM_TEXTE}`;
  if (!sonsDAttente.has(cle)) {
    sonsDAttente.set(cle, (async () => {
      try {
        const r = await fetch("https://api.x.ai/v1/tts", {
          method: "POST",
          headers: { authorization: `Bearer ${XAI_API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({ text: MMM_TEXTE, voice_id: voix, language: AGENT_LANG, output_format: { codec: "mulaw", sample_rate: 8000 }, speed: vitesse }),
        });
        if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
        const son = rognerSon(Buffer.from(await r.arrayBuffer()));
        if (!son.length) throw new Error("son vide");
        console.log(`[attente] « ${MMM_TEXTE} » pret pour la voix ${voix} (${(son.length / 8000).toFixed(2)} s)`);
        return son;
      } catch (err) {
        console.error(`[attente] « ${MMM_TEXTE} » impossible pour la voix ${voix} : ${err.message}`);
        sonsDAttente.delete(cle); // l'appel suivant reessaie
        return null;
      }
    })());
  }
  return sonsDAttente.get(cle);
}
// Le son rendu par la synthese commence et finit par du silence : chaque milliseconde gardee retarde la vraie
// reponse qui le suit en file. On garde 20 ms avant la voix et 60 ms apres, en fondu pour eviter un clic.
function rognerSon(ulaw) {
  const n = Math.floor(ulaw.length / 160);
  let premier = -1, dernier = -1;
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (let i = 0; i < 160; i++) { const v = ulawDecodeSample(ulaw[k * 160 + i]); s += v * v; }
    if (Math.sqrt(s / 160) >= SEUIL_SON_RMS) { if (premier < 0) premier = k; dernier = k; }
  }
  if (premier < 0) return Buffer.alloc(0);
  const debut = Math.max(0, premier - 1) * 160, fin = Math.min(n, dernier + 4) * 160;
  const son = Buffer.from(ulaw.subarray(debut, fin));
  const fondu = Math.min(320, son.length >> 2);
  for (let i = 0; i < fondu; i++) {
    son[i] = ulawEncodeSample(Math.round(ulawDecodeSample(son[i]) * (i / fondu)));
    const j = son.length - 1 - i;
    son[j] = ulawEncodeSample(Math.round(ulawDecodeSample(son[j]) * (i / fondu)));
  }
  return son;
}
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
  let attenteCreation = false, creationDemandeeA = 0; // response.create envoye apres un commit, response.created pas encore recu
  // Reponse anticipee (voir ANTICIPATION_MS) : { tour, etat "demandee" | "creee" | "finie", annulee, annuleeA, voixDepuis,
  // audio (mu-law retenu jusqu'a la fin du tour), pretA, fin (response.done differe), items (de la reponse), closingAvant, depuis }
  let anticipation = null;
  const itemsAjoutes = new Set(); // elements reellement crees chez Grok : on n'efface que ceux-la
  let suppressionsEnCours = 0;
  let reponseAnticipee = 0, anticipeePreteA = 0; // pour le journal de latence de la reponse confirmee
  // « Mmm » d'attente (voir MMM_APRES_MS) : fin de parole du client dont la reponse n'a encore rien fait entendre,
  // indicateur pour le journal de latence, son pret pour la voix de cet appel.
  let attenteDepuis = 0, mmmJusqua = 0, mmmAvantReponse = false;
  let sonMmm = null;

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
    if (maintenant < mmmJusqua) return; // parler sur le « Mmm » d'attente ne jette pas la reponse qui arrive
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
    attenteCreation = true; creationDemandeeA = Date.now();
    grok.send(JSON.stringify({ type: "response.create" }));
  }
  // Grok a ignore la demande (tour sans mot reconnu) : la voix retenue repart, rien n'attend plus.
  function reponseIgnoree() {
    attenteCreation = false;
    attenteDepuis = 0; // aucune reponse ne vient : pas de « Mmm »
    if (reponseAnticipee === -1) reponseAnticipee = 0;
    console.log(`[tour] Grok n'a pas cree la reponse en ${Date.now() - creationDemandeeA} ms (aucun mot reconnu ?), la voix du client repart ${t()} sid=${callSid}`);
    if (anticipation) {
      const a = anticipation;
      if (a.annulee) { finirAnnulation(null); return; }
      // Rien n'a ete cree, donc rien a effacer. Le tour n'avait pas de mot : a sa fin, il sera ignore,
      // sauf si de la vraie voix suit (sansMot garde la voix mesuree a ce moment-la).
      anticipation = null;
      a.tour.sansMot = a.tour.voixMs;
      toursValides--;
    }
    generation = false; reponseActive = false;
    lacherRetenue();
    if (tourEnAttente && !tour) { validerTour(); demanderReponse(); }
  }

  // ---- Reponse anticipee (voir ANTICIPATION_MS) ----
  const sansMot = (tr) => tr.sansMot !== undefined && tr.voixMs - tr.sansMot < ANNULATION_VOIX_MS;
  const agentAudibleA = (maintenant) => maintenant < finLecture || (agentSpeaking && audioReponseOctets > 0);
  // Seul un tour que finDuTour validerait est anticipe, et jamais pendant que l'agent est audible.
  function peutAnticiper(maintenant) {
    if (!ANTICIPATION_MS || FIN_DE_TOUR_MS - ANTICIPATION_MS < 200) return false;
    if (!tour || sansMot(tour) || anticipation || generation || tourEnAttente || endRequested) return false;
    if (!(grok && grok.readyState === WebSocket.OPEN && grokReady)) return false;
    if (maintenant - tour.derniereVoix < ANTICIPATION_MS || agentAudibleA(maintenant)) return false;
    const agentContinue = !tour.coupe && finLecture > tour.derniereVoix + 500;
    const voixMinimale = tour.derniereVoix < accueilProtegeJusqua ? PAROLE_ACCUEIL_MS : PAROLE_COUPURE_MS;
    return !(tour.voixMs < 150 || (agentContinue && tour.voixMs < voixMinimale));
  }
  function lancerAnticipation() {
    anticipation = { tour, etat: "demandee", annulee: false, annuleeA: 0, voixDepuis: 0, audio: [], pretA: 0, fin: null, items: [], closingAvant: closingSaid, depuis: Date.now() };
    console.log(`[tour] anticipe : ${Math.round(tour.voixMs)} ms de voix, dernier son a t+${((tour.derniereVoix - debutAppelMs) / 1000).toFixed(2)}, reponse lancee ${t()}`);
    validerTour();
    demanderReponse();
  }
  // Fin du tour confirmee : le son deja pret part, et ce qui attendait la fin de la reponse suit.
  function confirmerAnticipation(fini) {
    const a = anticipation;
    anticipation = null;
    retenue = []; // la fin du tour : du silence ou des sons trop brefs pour compter, comme un son ignore
    finParoleClientMs = fini.derniereVoix;
    console.log(`[tour] client : ${Math.round(fini.voixMs)} ms de voix, dernier son a t+${((fini.derniereVoix - debutAppelMs) / 1000).toFixed(2)}, reponse anticipee ${a.etat === "demandee" ? "pas encore creee" : a.audio.length ? "prete" : "en cours"} ${t()}`);
    reponseAnticipee = a.etat === "demandee" ? -1 : respSeq; // -1 : numerotee a sa creation
    anticipeePreteA = a.pretA;
    attenteDepuis = fini.derniereVoix;
    for (const u of a.audio) envoyerSonAgent(u);
    if (a.etat === "finie") terminerReponse(a.fin);
  }
  // Le client reprend : la reponse lancee trop tot est annulee, puis effacee (finirAnnulation).
  function annulerAnticipation(pourquoi) {
    const a = anticipation;
    if (!a || a.annulee) return;
    a.annulee = true;
    a.annuleeA = Date.now();
    toursValides--;
    console.log(`[tour] anticipation annulee : ${pourquoi} ${t()}`);
    if (a.etat === "finie") { finirAnnulation(null); return; }
    // Envoye avant response.created, l'annulation s'applique a la reponse des sa creation.
    if (grok && grok.readyState === WebSocket.OPEN) grok.send(JSON.stringify({ type: "response.cancel" }));
  }
  function finirAnnulation(e) {
    const a = anticipation;
    anticipation = null;
    if (e) console.log(`[reponse] n°${respSeq} statut=${e.response?.status || "?"} (anticipation annulee) texte=${agentBuf.length}car ${t()} sid=${callSid}`);
    // Grok ne doit garder aucune trace de la reponse lancee trop tot. Le message du client, lui, reste : la suite s'y ajoute.
    const aEffacer = a.items.filter((id) => itemsAjoutes.has(id));
    if (grok && grok.readyState === WebSocket.OPEN) {
      for (const id of aEffacer) { suppressionsEnCours++; grok.send(JSON.stringify({ type: "conversation.item.delete", item_id: id })); }
    }
    agentBuf = ""; closingSaid = a.closingAvant;
    reponseCoupee = respSeq; agentSpeaking = false;
    // La ligne du client reservee avec la phrase partielle : la transcription de la phrase entiere la remplacera.
    if (tourClient && tourClient.idx != null && tourClient.idx === dialog.length - 1 && dialog[tourClient.idx].who === "Client") dialog.pop();
    tourClient = null; userBuf = "";
    reponseActive = false; generation = false; attenteCreation = false;
    const suite = retenue.length;
    lacherRetenue();
    console.log(`[tour] anticipation effacee (${aEffacer.length} element${aEffacer.length > 1 ? "s" : ""}), la suite de la phrase repart (${(suite * 0.02).toFixed(1)} s) ${t()}`);
    if (tourEnAttente && !tour) { validerTour(); demanderReponse(); }
  }
  // Le client attend et rien ne sort encore : « Mmm… » (voir MMM_APRES_MS), une fois par tour du client.
  function jouerMmm(maintenant) {
    const depuis = maintenant - attenteDepuis;
    attenteDepuis = 0;
    if (!sonMmm || !streamSid || twilio.readyState !== WebSocket.OPEN) return;
    for (let o = 0; o < sonMmm.length; o += 800) {
      twilio.send(JSON.stringify({ event: "media", streamSid, media: { payload: sonMmm.subarray(o, o + 800).toString("base64") } }));
    }
    finLecture = Math.max(finLecture, maintenant) + (sonMmm.length / 8000) * 1000;
    mmmJusqua = finLecture;
    mmmAvantReponse = true;
    console.log(`[attente] « ${MMM_TEXTE} » ${depuis} ms apres la fin de parole du client ${t()} sid=${callSid}`);
  }
  // Son de l'agent vers Twilio, et mesure de la latence au premier son de chaque reponse.
  function envoyerSonAgent(ulaw) {
    attenteDepuis = 0;
    twilio.send(JSON.stringify({ event: "media", streamSid, media: { payload: ulaw.toString("base64") } }));
    finLecture = Math.max(finLecture, Date.now()) + (ulaw.length / 8000) * 1000;
    audioReponseOctets += ulaw.length;
    if (!premierSon) {
      // LATENCE MESUREE : ce que l'appelant attend vraiment, depuis la fin de sa phrase.
      premierSon = true;
      if (accueilProtegeJusqua === Infinity) accueilProtegeJusqua = Date.now() + (respSeq === 1 ? ACCUEIL_PROTEGE_MS : 0);
      console.log(`[latence] n°${respSeq} premier son ${Date.now() - debutReponseMs} ms apres la creation${finParoleClientMs ? `, ${Date.now() - finParoleClientMs} ms apres la fin de parole du client` : ""}${respSeq === reponseAnticipee ? ` (anticipee${anticipeePreteA ? `, prete ${anticipeePreteA - debutReponseMs} ms apres la creation` : ""})` : ""}${mmmAvantReponse ? " (apres « Mmm »)" : ""} ${t()} sid=${callSid}`);
      finParoleClientMs = 0;
      mmmAvantReponse = false;
    }
  }
  // Fin d'une reponse de Grok : journal, queue de silence, mark de fin de lecture. Differee pour une reponse anticipee.
  function terminerReponse(e) {
    // JOURNAL PAR REPONSE : statut de Grok, secondes d'audio reellement envoyees a Twilio et duree de generation.
    // Un texte trop long pour sa duree d'audio (~17 car/s) trahit une reponse arretee net par Grok.
    const r = e.response || {};
    console.log(`[reponse] n°${respSeq} statut=${r.status || "?"}${r.status_details ? " " + JSON.stringify(r.status_details).slice(0, 200) : ""} audio=${(audioReponseOctets / 8000).toFixed(1)}s generee_en=${((Date.now() - debutReponseMs) / 1000).toFixed(1)}s texte=${agentBuf.length}car ${t()} sid=${callSid}`);
    // Surveillance des fins avalees : une transcription de Grok qui finit sans ponctuation a perdu son dernier signe,
    // et sa derniere syllabe avec (voir TYPO_COLLEE). Hors reponse coupee par le client, qui s'arrete forcement net.
    if (agentBuf.trim() && respSeq !== reponseCoupee && !/[.?!…»"')\]]\s*$/.test(agentBuf.trim())) {
      console.log(`[coupure] fin avalee probable n°${respSeq} : « …${agentBuf.trim().slice(-70)} » ${t()} sid=${callSid}`);
    }
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
    else attenteDepuis = 0; // plus rien n'arrive pour ce tour : pas de « Mmm » apres coup
    if (closeTriggered && !endRequested) requestHangup("cloture polie");
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
    if (anticipation && anticipation.tour === fini && !anticipation.annulee) { confirmerAnticipation(fini); return; }
    // L'agent parle encore bien apres ce son : « mmm », « oui », un souffle. Sans BARGE_IN, ce qui est dit pendant
    // que l'agent est audible n'est meme pas compte (voir le handler media) : il ne reste ici que la voix d'avant son
    // premier son, par exemple la fin d'une phrase reprise juste apres une pause.
    const agentContinue = !fini.coupe && finLecture > fini.derniereVoix + 500;
    const pendantAccueil = fini.derniereVoix < accueilProtegeJusqua;
    const voixMinimale = pendantAccueil ? PAROLE_ACCUEIL_MS : PAROLE_COUPURE_MS;
    // sansMot : l'anticipation de ce tour a montre que Grok n'y reconnaissait aucun mot, et rien n'a suivi.
    if (sansMot(fini) || fini.voixMs < 150 || (agentContinue && fini.voixMs < voixMinimale)) {
      toursIgnores++;
      console.log(`[tour] son ignore : ${Math.round(fini.voixMs)} ms de voix${sansMot(fini) ? " sans mot reconnu" : ""}${agentContinue ? " pendant que l'agent parle" : ""} ${t()}`);
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
    attenteDepuis = fini.derniereVoix;
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
    if (TOURS_PAR_LE_PONT && MMM_APRES_MS > 0) sonDAttente(GROK_VOICE, GROK_SPEED).then((s) => { sonMmm = s; });

    grok.on("open", () => {
      const callerFr = frPhone(fromNumber);
      const callerSpoken = callerFr ? frPhoneSpoken(callerFr) : "";
      const contexte = [
        callerFr ? `Le client appelle depuis le numéro ${callerFr}. Quand tu lui relis ce numéro à voix, tu prononces EXACTEMENT ceci, mot pour mot, sans le recalculer ni changer un seul groupe : « ${callerSpoken} ». C'est son numéro de rappel par défaut, tu le connais déjà.` : "",
        EVITER_FIN_SUR_QUESTION ? "Au téléphone, ta voix avale la fin d'une réponse qui se termine sur une question. Ne finis donc jamais sur le point d'interrogation : après ta question, ajoute toujours deux ou trois mots, variés d'une fois sur l'autre (« Je vous écoute. », « Dites-moi. », « Prenez votre temps. »)." : "",
      ].filter(Boolean).join("\n");
      const contexteTypo = [contexte, TYPO_COLLEE ? CONSIGNE_PONCTUATION : ""].filter(Boolean).join("\n");
      const sessionInstructions = collerPonctuation(contexteTypo ? `${RECEPTION_PROMPT}\n\n# Contexte de cet appel\n${contexteTypo}` : RECEPTION_PROMPT);
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
          attenteCreation = false;
          if (anticipation) anticipation.etat = "creee";
          resteAudio = Buffer.alloc(0);
          audioReponseOctets = 0; debutReponseMs = Date.now(); premierSon = false;
          pushUser(); // le tour du client est fini, l'agent repond
          respSeq++;
          agentSpeaking = true; agentSpeakingSince = Date.now(); // Dany commence a parler -> on coupe l'ecoute (anti-echo)
          if (reponseAnticipee === -1) reponseAnticipee = respSeq;
          console.log(`[turn] ${AGENT_NAME} n°${respSeq}${anticipation || reponseAnticipee === respSeq ? " (anticipee)" : ""} ${t()}`);
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
          if (anticipation) { // la fin du tour n'est pas confirmee : le son attend
            if (!anticipation.annulee) { if (!anticipation.pretA) anticipation.pretA = Date.now(); anticipation.audio.push(ulaw); }
            break;
          }
          envoyerSonAgent(ulaw);
          break;
        }
        case "response.output_audio_transcript.delta":
          if (e.delta) { agentBuf += e.delta; if (/remercie pour votre appel/i.test(agentBuf)) closingSaid = true; }
          break;
        case "response.done": {
          if (anticipation) {
            // Reponse anticipee : annulee, elle s'efface ; finie avant la fin du tour, tout attend la confirmation.
            if (anticipation.annulee) finirAnnulation(e);
            else { anticipation.etat = "finie"; anticipation.fin = e; reponseActive = false; }
            break;
          }
          if (e.response?.status === "cancelled") { // le pont n'annule qu'une anticipation : reliquat d'une annulation deja soldee
            console.log(`[reponse] n°${respSeq} statut=cancelled (reliquat) ${t()} sid=${callSid}`);
            reponseActive = false; generation = false; agentBuf = "";
            lacherRetenue();
            break;
          }
          terminerReponse(e);
          break;
        }
        case "conversation.item.added":
          if (e.item?.id) itemsAjoutes.add(e.item.id);
          // Ce que la reponse anticipee ajoute s'effacera avec elle si elle est annulee.
          if (anticipation && anticipation.etat !== "demandee" && e.item?.id && e.item.role !== "user") anticipation.items.push(e.item.id);
          if (!typesVus.has(e.type)) { typesVus.add(e.type); console.log(`[grok] ${e.type}${e.item?.type ? " " + e.item.type : ""} ${t()}`); }
          break;
        case "conversation.item.deleted":
          suppressionsEnCours = Math.max(0, suppressionsEnCours - 1);
          console.log(`[grok] ${e.type} ${t()}`);
          break;
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
          // Un effacement refuse (anticipation annulee) n'est pas un refus de reponse : rien a relacher.
          if (suppressionsEnCours > 0 && /item/i.test(JSON.stringify(e.error || e))) { suppressionsEnCours--; break; }
          // Une demande de reponse refusee ne doit pas laisser la voix du client retenue pour toujours.
          if (TOURS_PAR_LE_PONT && generation && !reponseActive && !anticipation) { generation = false; attenteCreation = false; lacherRetenue(); }
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
        if (attenteCreation && maintenant - creationDemandeeA > REPONSE_IGNOREE_MS) reponseIgnoree();
        if (attenteDepuis && MMM_APRES_MS > 0 && !tour && !endRequested && maintenant - attenteDepuis >= MMM_APRES_MS
          && !agentAudibleA(maintenant) && (generation || tourEnAttente)
          && !(reponseActive && maintenant - debutReponseMs < MMM_CREEE_DEPUIS_MS) // son imminent : pas de « Mmm » devant
          && !(generation && !reponseActive && maintenant - generationDemandeeA < 400)) jouerMmm(maintenant); // relance tout juste demandee
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
          if (anticipation && anticipation.tour === tour && !anticipation.annulee && (anticipation.voixDepuis += paquetMs) >= ANNULATION_VOIX_MS) {
            annulerAnticipation(`le client reprend (${Math.round(anticipation.voixDepuis)} ms de voix)`);
          }
        }
        if (tour) {
          if (!sourd) envoyerAGrok([pcm]);
          verifierCoupure();
          if (tour && !voix && peutAnticiper(maintenant)) lancerAnticipation();
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
      grok.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: collerPonctuation(text) }] } }));
      if (TOURS_PAR_LE_PONT) marquerGeneration();
      grok.send(JSON.stringify({ type: "response.create" }));
    } catch {}
  }

  // Gestion du silence : 1) "vous etes toujours la ?" ; 2) si toujours silence, conge poli puis raccroche.
  const inactivityTimer = setInterval(() => {
    // Filet : une reponse demandee qui ne vient jamais (8 s) ou qui ne se termine jamais (30 s) ne doit pas
    // garder la voix du client retenue ; Grok a deja abandonne des reponses sans response.done.
    if (TOURS_PAR_LE_PONT && generation && !finalized && !anticipation) {
      const depuis = Date.now() - generationDemandeeA;
      if ((!reponseActive && depuis > 8000) || depuis > 30000) {
        console.log(`[tour] reponse jamais terminee (${Math.round(depuis / 1000)} s), la voix du client repart ${t()} sid=${callSid}`);
        generation = false; reponseActive = false; attenteCreation = false;
        lacherRetenue();
        if (tourEnAttente && !tour) { validerTour(); demanderReponse(); }
      }
    }
    // Filets de l'anticipation : un tour tenu ouvert par des bruits, ou une annulation jamais soldee par Grok.
    if (anticipation && !finalized) {
      if (!anticipation.annulee && Date.now() - anticipation.depuis > 10000) annulerAnticipation("plus de 10 s sans fin de tour");
      else if (anticipation.annulee && Date.now() - anticipation.annuleeA > 5000) finirAnnulation(null);
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
