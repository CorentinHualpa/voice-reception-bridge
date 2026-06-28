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
//   PORT               injecte par Railway

import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { ulaw8kToPcm16, pcm16ToUlaw8k } from "./lib/audio.js";

const PORT = process.env.PORT || 8080;
const XAI_API_KEY = process.env.XAI_API_KEY;
const GROK_MODEL = process.env.GROK_MODEL || "grok-voice-latest";
const GROK_VOICE = process.env.GROK_VOICE || "eve";
const GROK_RATE = Number(process.env.GROK_RATE || 8000);
const AGENT_LANG = process.env.AGENT_LANG || "fr";
const AGENT_NAME = process.env.AGENT_NAME || "Dany";
const BUSINESS_NAME = process.env.BUSINESS_NAME || "l'entreprise";
const BUSINESS_DESC = process.env.BUSINESS_DESC || "";
const N8N_RECAP_URL = process.env.N8N_RECAP_URL || "";

if (!XAI_API_KEY) console.error("[boot] ATTENTION: XAI_API_KEY manquante");

// Instruction de l'agent de reception (cf. agent-voiceflow-creator : voice_intake.md / voice_agent.md).
// Configurable par env (AGENT_NAME / BUSINESS_NAME / BUSINESS_DESC), surchargeable via RECEPTION_PROMPT.
const RECEPTION_PROMPT = process.env.RECEPTION_PROMPT || `Tu es ${AGENT_NAME}, l'assistant vocal telephonique de ${BUSINESS_NAME}${BUSINESS_DESC ? " (" + BUSINESS_DESC + ")" : ""}. Tu decroches quand le standard est ferme (hors horaires). Tu vouvoies, tu es chaleureux, calme et clair, une idee par phrase, une seule question a la fois.

Tu fais le tri :
- Question simple que tu connais (horaires, adresse, services) : tu reponds directement, tu ne demandes aucune coordonnee.
- Vrai besoin (devis, SAV, suivi, demande de rappel) : tu qualifies puis tu transmets pour rappel. Tu captes, dans l'ordre, une info a la fois : le besoin precis, puis le nom et le prenom, puis l'adresse email (demandee une seule fois, sans epeler), puis la ville. Le numero de telephone est deja connu (le numero appelant).

Tu confirmes a voix haute les marques, references et noms (pieges phonetiques). Tu ne donnes jamais de prix, de delai ferme ni de disponibilite ; tu dis qu'un conseiller confirmera. Tu n'inventes jamais une information.

A la fin, tu dis une phrase de cloture ("toute l'equipe vous remercie, un conseiller vous rappellera, bonne journee") et tu laisses la personne raccrocher. Tu n'envoies aucun mail toi-meme : le recap part automatiquement.

Reponds toujours en ${AGENT_LANG === "es" ? "espagnol" : AGENT_LANG === "en" ? "anglais" : "francais"}.`;

const server = http.createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];
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
  let grok = null;
  let grokReady = false;
  const dialog = []; // { who: 'Client' | 'Agent', msg }
  let userBuf = "";
  let agentBuf = "";
  let finalized = false;

  function pushUser() { const t = userBuf.trim(); if (t) dialog.push({ who: "Client", msg: t }); userBuf = ""; }
  function pushAgent() { const t = agentBuf.trim(); if (t) dialog.push({ who: "Agent", msg: t }); agentBuf = ""; }

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
      grok.send(JSON.stringify({
        type: "session.update",
        session: {
          instructions: RECEPTION_PROMPT,
          voice: GROK_VOICE,
          turn_detection: { type: "server_vad", threshold: 0.6 },
          input_audio_transcription: { language: AGENT_LANG },
          audio: {
            input: { format: { type: "audio/pcm", rate: GROK_RATE } },
            output: { format: { type: "audio/pcm", rate: GROK_RATE } },
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
          break;
        case "response.output_audio.delta": {
          if (!e.delta || !streamSid) break;
          const pcm = Buffer.from(e.delta, "base64");
          const ulaw = pcm16ToUlaw8k(pcm, GROK_RATE);
          twilio.send(JSON.stringify({ event: "media", streamSid, media: { payload: ulaw.toString("base64") } }));
          break;
        }
        case "response.output_audio_transcript.delta":
          if (e.delta) agentBuf += e.delta;
          break;
        case "response.done":
          pushAgent();
          break;
        case "conversation.item.input_audio_transcription.updated":
          if (typeof e.transcript === "string") userBuf = e.transcript; // cumulatif sur le tour
          break;
        case "input_audio_buffer.speech_started":
          if (streamSid) twilio.send(JSON.stringify({ event: "clear", streamSid })); // barge-in : vider la file Twilio
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
      console.log(`[call] start sid=${callSid} from=${fromNumber}`);
      openGrok();
    } else if (m.event === "media") {
      if (grok && grok.readyState === WebSocket.OPEN && grokReady) {
        const pcm = ulaw8kToPcm16(Buffer.from(m.media.payload, "base64"), GROK_RATE);
        grok.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
      }
    } else if (m.event === "stop") {
      finalize();
    }
  });
  twilio.on("close", finalize);
  twilio.on("error", (err) => console.error("[twilio] ws error", err.message));

  async function finalize() {
    if (finalized) return;
    finalized = true;
    pushUser();
    pushAgent();
    try { if (grok && grok.readyState === WebSocket.OPEN) grok.close(); } catch {}
    const text = dialog.map((l) => `${l.who} : ${l.msg}`).join("\n");
    console.log(`[call] stop sid=${callSid} lignes=${dialog.length}`);
    const hasClient = dialog.some((l) => l.who === "Client");
    if (hasClient && N8N_RECAP_URL) {
      try {
        await fetch(N8N_RECAP_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dialog: text, phone: fromNumber || "inconnu", call_sid: callSid }),
        });
        console.log("[recap] envoye a n8n");
      } catch (e) {
        console.error("[recap] echec POST n8n", e.message);
      }
    }
  }
});

server.listen(PORT, () => console.log(`[boot] voice-reception-bridge sur :${PORT} (rate Grok ${GROK_RATE})`));
