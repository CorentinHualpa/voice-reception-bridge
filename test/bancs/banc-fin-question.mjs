// La coupure vient-elle de la QUESTION finale ? Vraie session de Chiara, phrases courtes dites mot pour mot :
// question avec « puis écoute », question sans, affirmation, question suivie d'un mot de relance. Cinq essais
// chacune, on compte les fins abruptes (énergie encore forte dans les 180 ms avant la fin).
import path from "node:path";
import { fileURLToPath } from "node:url";
const ICI = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(ICI, "fixtures");
import fs from "node:fs";
import { createPizzeria } from "../../lib/pizzeria.js";

const S = process.env.BANC_SORTIE || path.join(ICI, ".sorties");
fs.mkdirSync(S, { recursive: true });
const vault = fs.readFileSync(process.env.VAULT || "C:/Users/msi/.secrets/api-keys.env", "utf8");
const XAI = (vault.match(/^XAI_API_KEY=(.*)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
const session = JSON.parse(fs.readFileSync(`${process.env.BANC_SESSION || path.join(FIXTURES, "session-palazzo.json")}`, "utf8"));
const pizzeria = createPizzeria({ menuFile: path.join(ICI, "../../menus/palazzo.json") });
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const rms = (b, d, f) => { let s = 0, n = 0; for (let i = Math.max(0, d); i + 1 < f; i += 2) { const v = b.readInt16LE(i); s += v * v; n++; } return n ? Math.round(Math.sqrt(s / n)) : 0; };

const CAS = {
  "question": { phrase: "Allora, que désirez-vous commander ?", suite: "" },
  "q+je-vous-ecoute": { phrase: "Allora, que désirez-vous commander ? Je vous écoute !", suite: "" },
  "q+points": { phrase: "Allora, que désirez-vous commander ?…", suite: "" },
  "indirecte": { phrase: "Allora, dites-moi ce que vous désirez commander.", suite: "" },
  "q-sans-point-int": { phrase: "Allora, que désirez-vous commander.", suite: "" },
};

const tok = await fetch("https://api.x.ai/v1/realtime/client_secrets", { method: "POST", headers: { Authorization: `Bearer ${XAI}`, "Content-Type": "application/json" }, body: JSON.stringify({ expires_after: { seconds: 600 } }) }).then((r) => r.json());
const ws = new WebSocket("wss://api.x.ai/v1/realtime?model=grok-voice-latest", [`xai-client-secret.${tok.value || tok.client_secret?.value}`]);
await new Promise((ok) => { ws.onopen = ok; });
let courant = [], fini = false;
const pret = new Promise((ok) => {
  ws.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === "session.updated") ok();
    else if (e.type === "response.output_audio.delta") courant.push(Buffer.from(e.delta, "base64"));
    else if (e.type === "response.done") fini = true;
  };
});
ws.send(JSON.stringify({ type: "session.update", session: {
  instructions: `${session.instructions}\n\n# Contexte de cet appel\n${pizzeria.contexteAppel()}`,
  voice: session.voice, reasoning: { effort: "none" },
  audio: { input: { format: { type: "audio/pcm", rate: 8000 }, turn_detection: null }, output: { format: { type: "audio/pcm", rate: 8000 }, speed: Number(session.speed) || 1 } },
} }));
await pret;
const bilan = {};
for (let n = 1; n <= 5; n++) {
  for (const [nom, c] of Object.entries(CAS)) {
    courant = []; fini = false;
    ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "(SYSTÈME : phrase suivante.)" }] } }));
    ws.send(JSON.stringify({ type: "response.create", response: { instructions: `Dis exactement cette phrase, mot pour mot, sans rien ajouter avant ni apres${c.suite} : « ${c.phrase} »` } }));
    for (let k = 0; k < 150 && !fini; k++) await attendre(100);
    const p = Buffer.concat(courant); const pcm = p.subarray(0, p.length - (p.length % 2)); const L = pcm.length;
    const avant = rms(pcm, L - 1600, L - 160);
    const abrupt = avant > 600;
    (bilan[nom] ??= []).push(`${(L / 16000).toFixed(2)}s:${avant}${abrupt ? "!" : ""}`);
  }
}
ws.close();
for (const [nom, l] of Object.entries(bilan)) console.log(`${nom.padEnd(16)} abruptes ${l.filter((x) => x.endsWith("!")).length}/5  ${l.join("  ")}`);
