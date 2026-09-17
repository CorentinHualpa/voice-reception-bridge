// Ce que Grok garde vraiment d'une phrase validée trop tôt puis annulée, au rythme réel du pont (paquets de 20 ms,
// silence envoyé tant que le tour est ouvert, voix retenue pendant la génération). Constat du banc d'appel local
// (17/09/2026) : après conversation.item.delete puis renvoi de la phrase entière, la transcription reprend le MÊME
// item_id et double le début (« Attendez, en fait, attendez, en fait, est-ce que… »). Trois variantes, puis une
// question de contrôle en texte pour savoir ce que le MODÈLE a reçu (pas seulement la transcription affichée) :
//   A  effacer le message partiel, renvoyer la phrase entière (ce que fait le pont)
//   B  garder le message partiel, n'effacer que la réponse, envoyer seulement la suite
//   C  effacer le message partiel, vider le tampon (input_audio_buffer.clear), attendre, renvoyer la phrase entière
// Résultat du 17/09/2026 : A double le début chez le modèle (« Attendez, en fait, attendez, en fait, est-c'que… »,
// et l'effacement répond parfois « Item not found ») ; B et C donnent la phrase entière une seule fois. Le pont fait B.
// Usage : node test/bancs/banc-anticipation-ids.mjs [A|B|C]
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const vault = fs.readFileSync(process.env.VAULT || "C:/Users/msi/.secrets/api-keys.env", "utf8");
const CLE = (vault.match(/^XAI_API_KEY=(.*)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
// « Attendez, en fait… (pause 460 ms) …est-ce que vous faites des pizzas sans gluten ? » : voix jusqu'à 26,46 s, reprise à 26,92 s.
const PHRASE = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", "25.0", "-to", "29.3", "-i", path.join(ICI, "fixtures", "client-polly.wav"), "-f", "s16le", "-ac", "1", "-ar", "8000", "-"], { maxBuffer: 64 * 1024 * 1024 });
const paquets = []; for (let o = 0; o + 320 <= PHRASE.length; o += 320) paquets.push(PHRASE.subarray(o, o + 320));
const SILENCE = Buffer.alloc(320);
const iPause = Math.round((26.46 - 25.0) / 0.02);   // dernier paquet de voix avant la pause
const iAnticipe = iPause + 20;                      // 400 ms de silence : le pont valide et lance la réponse
const iReprise = Math.round((26.92 - 25.0) / 0.02) + 8; // 160 ms de voix après la reprise : le pont annule

async function variante(nom) {
  const tok = await fetch("https://api.x.ai/v1/realtime/client_secrets", { method: "POST", headers: { Authorization: `Bearer ${CLE}`, "Content-Type": "application/json" }, body: JSON.stringify({ expires_after: { seconds: 300 } }) }).then((r) => r.json());
  const ws = new WebSocket("wss://api.x.ai/v1/realtime?model=grok-voice-latest", [`xai-client-secret.${tok.value || tok.client_secret?.value}`]);
  await new Promise((ok) => { ws.onopen = ok; });
  const t0 = Date.now();
  const log = (l) => console.log(`[${nom}] ${((Date.now() - t0) / 1000).toFixed(2).padStart(6)} ${l}`);
  const evts = [];
  let texte = "";
  const attentes = [];
  ws.onmessage = (m) => {
    const e = JSON.parse(m.data); e._a = Date.now(); evts.push(e);
    if (e.type === "response.output_audio_transcript.delta") { texte += e.delta || ""; return; }
    if (/^(ping|response\.output_audio\.delta|response\.content_part|response\.output_audio_transcript\.done|response\.output_audio\.done|response\.output_item|conversation\.item\.input_audio_transcription\.delta)/.test(e.type)) return;
    const d = [];
    if (e.item_id) d.push(`item=${e.item_id.slice(0, 8)}`);
    if (e.item) d.push(`item=${e.item.id?.slice(0, 8)}/${e.item.role || e.item.type}`);
    if (e.response) d.push(`statut=${e.response.status}`);
    if (e.transcript) d.push(`« ${e.transcript} »`);
    if (e.error) d.push(`ERREUR ${JSON.stringify(e.error).slice(0, 200)}`);
    log(`${e.type} ${d.join(" ")}`);
    for (const a of attentes.splice(0)) { if (a.pred(e)) a.ok(e); else attentes.push(a); }
  };
  const envoyer = (o) => ws.send(JSON.stringify(o));
  const attendreEvt = (pred, ms = 8000) => new Promise((ok) => { const a = { pred, ok }; attentes.push(a); setTimeout(() => { const i = attentes.indexOf(a); if (i >= 0) { attentes.splice(i, 1); ok(null); } }, ms); });
  envoyer({ type: "session.update", session: {
    instructions: "Tu es Chiara, au téléphone chez Palazzo Pizza. Réponses courtes. On ne fait pas de pizza sans gluten.",
    voice: "eve", reasoning: { effort: "none" },
    audio: { input: { format: { type: "audio/pcm", rate: 8000 }, transcription: { model: "grok-transcribe", language_hint: "fr" }, turn_detection: null }, output: { format: { type: "audio/pcm", rate: 8000 }, speed: 1.1 } },
  } });
  await attendreEvt((e) => e.type === "session.updated");
  const debut = Date.now();
  const auRythme = async (i) => { const w = debut + i * 20 - Date.now(); if (w > 0) await attendre(w); };
  // 1) la phrase jusqu'à la pause, puis 400 ms de silence, au rythme réel
  for (let i = 0; i < iAnticipe; i++) { await auRythme(i); envoyer({ type: "input_audio_buffer.append", audio: (i <= iPause ? paquets[i] : SILENCE).toString("base64") }); }
  // 2) le pont valide et demande la réponse ; la voix qui suit est retenue
  let commit = null;
  const pCommit = attendreEvt((e) => e.type === "input_audio_buffer.committed");
  envoyer({ type: "input_audio_buffer.commit" });
  envoyer({ type: "response.create" });
  log("--- anticipation lancée");
  commit = await pCommit;
  const itemsReponse = [];
  const pDone = attendreEvt((e) => e.type === "response.done", 10000);
  const collecte = (e) => { if (e.type === "conversation.item.added" && e.item?.role !== "user") itemsReponse.push(e.item.id); return false; };
  attentes.push({ pred: collecte, ok: () => {} });
  for (let i = iAnticipe; i < iReprise; i++) await auRythme(i); // la reprise, retenue
  log("--- le client reprend : annulation");
  envoyer({ type: "response.cancel" });
  const fin = await pDone;
  log(`annulée : ${fin?.response?.status} « ${texte} »`);
  const partiel = commit?.item_id;
  if (nom !== "B") envoyer({ type: "conversation.item.delete", item_id: partiel });
  for (const id of itemsReponse) envoyer({ type: "conversation.item.delete", item_id: id });
  let reprise;
  if (nom === "C") {
    envoyer({ type: "input_audio_buffer.clear" });
    await attendreEvt((e) => e.type === "input_audio_buffer.cleared", 2000);
    await attendre(300);
  }
  if (nom === "B") reprise = paquets.slice(iAnticipe, iReprise);                                        // la suite seulement (voix retenue)
  else reprise = [...paquets.slice(0, iPause + 1), ...Array(iAnticipe - iPause - 1).fill(SILENCE), ...paquets.slice(iAnticipe, iReprise)]; // tout depuis le début
  log(`--- renvoi de ${(reprise.length * 0.02).toFixed(2)} s`);
  for (const p of reprise) envoyer({ type: "input_audio_buffer.append", audio: p.toString("base64") });
  // 3) la fin de la phrase au rythme réel, puis 900 ms de silence, puis validation
  const reste = Date.now() - (debut + iReprise * 20);
  const debut2 = Date.now() - 0;
  for (let i = iReprise; i < paquets.length + 45; i++) { const w = debut2 + (i - iReprise) * 20 - Date.now(); if (w > 0) await attendre(w); envoyer({ type: "input_audio_buffer.append", audio: (paquets[i] || SILENCE).toString("base64") }); }
  void reste;
  texte = "";
  const pCommit2 = attendreEvt((e) => e.type === "input_audio_buffer.committed");
  envoyer({ type: "input_audio_buffer.commit" });
  envoyer({ type: "response.create" });
  const c2 = await pCommit2;
  log(`--- deuxième validation : item ${c2?.item_id?.slice(0, 8)} (le partiel était ${partiel?.slice(0, 8)})`);
  await attendreEvt((e) => e.type === "response.done", 15000);
  log(`réponse : « ${texte} »`);
  await attendre(700);
  texte = "";
  envoyer({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "Contrôle technique, réponds sans rien d'autre : recopie mot pour mot, entre guillemets, chacun des messages vocaux que je t'ai envoyés avant celui-ci, dans l'ordre, en les numérotant." }] } });
  envoyer({ type: "response.create" });
  await attendreEvt((e) => e.type === "response.done", 20000);
  log(`CONTRÔLE : « ${texte} »`);
  ws.close();
}

for (const v of (process.argv[2] ? [process.argv[2]] : ["A", "B", "C"])) await variante(v);
process.exit(0);
