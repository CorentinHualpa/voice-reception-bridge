// Réglages communs des bancs : l'agent joué est celui du service Railway `bridge` (Dany, Motralec) tel qu'il
// tourne en production le 17/09/2026. Chaque valeur se remplace par une variable BANC_* pour jouer un autre agent.
// Les clés sont lues dans le vault et ne sont jamais affichées.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ICI = path.dirname(fileURLToPath(import.meta.url));
export const RACINE = path.join(ICI, "../..");
export const FIXTURES = path.join(ICI, "fixtures");
export const SORTIES = process.env.BANC_SORTIE || path.join(ICI, ".sorties");
fs.mkdirSync(SORTIES, { recursive: true });

const vault = fs.readFileSync(process.env.VAULT || "C:/Users/msi/.secrets/api-keys.env", "utf8");
export const cle = (nom) => (vault.match(new RegExp(`^${nom}=(.*)$`, "m"))?.[1] ?? "").trim().replace(/^["']|["']$/g, "");

export const AGENT = {
  instructions: fs.readFileSync(process.env.BANC_PROMPT || path.join(RACINE, "prompt.motralec.txt"), "utf8"),
  voice: process.env.BANC_VOIX || "leo",
  speed: Number(process.env.BANC_VITESSE || 1.15),
  reasoning: process.env.BANC_REFLEXION || "none",
  model: process.env.BANC_MODELE || "grok-voice-latest",
};
// La première phrase imposée par le prompt (« mot pour mot »), pour les bancs qui la font dire.
AGENT.accueil = AGENT.instructions.match(/mot pour mot[^"]*"([^"]+)"/)?.[1] ?? "Bonjour, que puis-je faire pour vous ?";

export async function ouvrirGrok(session) {
  const tok = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${cle("XAI_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expires_after: { seconds: 600 } }),
  }).then((r) => r.json());
  const secret = tok.value || tok.secret || tok.token || tok.client_secret?.value;
  const ws = new WebSocket(`wss://api.x.ai/v1/realtime?model=${AGENT.model}`, [`xai-client-secret.${secret}`]);
  await new Promise((ok, ko) => { ws.onopen = ok; ws.onerror = () => ko(new Error("ws xAI")); });
  ws.send(JSON.stringify({ type: "session.update", session }));
  return ws;
}

export const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

export function wavMono8k(pcm) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
