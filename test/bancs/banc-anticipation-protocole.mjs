// Ce que la réponse anticipée demande à l'API de Grok, vérifié sur de vraies sessions (mode manuel, comme le pont) :
// 1) « Attendez, en fait » validé seul, réponse lancée puis annulée (response.cancel) : statut rendu, erreurs ;
//    puis effacement du message du client et de la réponse (conversation.item.delete), phrase entière renvoyée,
//    réponse normale, et question de contrôle : Grok se souvient-il de ce qui a été effacé ?
// 2) Annulation envoyée dans la foulée du response.create, avant response.created : erreur ou réponse fantôme ?
// 3) Annulation après response.done : forme de l'erreur (le pont ne doit pas la prendre pour un refus de réponse).
// Usage : node test/bancs/banc-anticipation-protocole.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(ICI, "fixtures");
const vault = fs.readFileSync(process.env.VAULT || "C:/Users/msi/.secrets/api-keys.env", "utf8");
const CLE = (vault.match(/^XAI_API_KEY=(.*)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
const extrait = (a, b) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(a), "-to", String(b), "-i", path.join(FIXTURES, "client-polly.wav"), "-f", "s16le", "-ac", "1", "-ar", "8000", "-"], { maxBuffer: 64 * 1024 * 1024 });
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

const DEBUT = extrait(25.0, 26.5);   // « Attendez, en fait »
const ENTIERE = extrait(25.0, 29.3); // « Attendez, en fait, est-ce que vous faites des pizzas sans gluten ? »
const JAMBON = extrait(15.0, 18.7);  // « Bonjour, qu'est-ce que vous avez comme pizza avec du jambon ? »

async function ouvrir(nom) {
  const tok = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
    method: "POST", headers: { Authorization: `Bearer ${CLE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expires_after: { seconds: 300 } }),
  }).then((r) => r.json());
  const ws = new WebSocket("wss://api.x.ai/v1/realtime?model=grok-voice-latest", [`xai-client-secret.${tok.value || tok.client_secret?.value}`]);
  const t0 = Date.now();
  const s = { ws, evts: [], attentes: [], texte: "", premierSon: null, cree: null };
  const horo = () => `${((Date.now() - t0) / 1000).toFixed(2)}`.padStart(6);
  s.log = (l) => console.log(`${nom} ${horo()} ${l}`);
  await new Promise((ok) => { ws.onopen = ok; });
  ws.onmessage = (m) => {
    const e = JSON.parse(m.data);
    e._a = Date.now();
    s.evts.push(e);
    if (e.type === "response.created") s.cree = e._a;
    if (e.type === "response.output_audio.delta") { if (!s.premierSon) s.premierSon = e._a; return; }
    if (e.type === "response.output_audio_transcript.delta") { s.texte += e.delta || ""; return; }
    if (/^(ping|response\.content_part|response\.output_audio_transcript\.done|response\.output_audio\.done|conversation\.item\.input_audio_transcription\.delta)/.test(e.type)) return;
    const d = [];
    if (e.item_id) d.push(`item_id=${e.item_id}`);
    if (e.previous_item_id !== undefined) d.push(`previous=${e.previous_item_id}`);
    if (e.item) d.push(`item=${e.item.id}/${e.item.type}/${e.item.role || ""}`);
    if (e.response) d.push(`response=${e.response.id} statut=${e.response.status}${e.response.status_details ? " " + JSON.stringify(e.response.status_details).slice(0, 120) : ""}`);
    if (e.transcript) d.push(`« ${e.transcript} »`);
    if (e.error) d.push(`ERREUR ${JSON.stringify(e.error).slice(0, 220)}`);
    s.log(`${e.type} ${d.join(" ")}`);
    for (const a of s.attentes.splice(0)) { if (a.pred(e)) a.ok(e); else s.attentes.push(a); }
  };
  s.envoyer = (o) => ws.send(JSON.stringify(o));
  s.attendre = (pred, ms = 8000, apres = 0) => new Promise((ok) => {
    const deja = s.evts.find((e) => !e._pris && e._a >= apres && pred(e));
    if (deja) { deja._pris = true; return ok(deja); }
    const a = { pred, ok: (e) => { e._pris = true; clearTimeout(a.tm); ok(e); } };
    a.tm = setTimeout(() => { s.attentes.splice(s.attentes.indexOf(a), 1); ok(null); }, ms);
    s.attentes.push(a);
  });
  s.envoyer({ type: "session.update", session: {
    instructions: "Tu es Chiara, au téléphone chez Palazzo Pizza. Réponses courtes, une ou deux phrases. On ne fait pas de pizza sans gluten. Pizzas au jambon : Roma et Regina.",
    voice: "eve", reasoning: { effort: "none" },
    audio: {
      input: { format: { type: "audio/pcm", rate: 8000 }, transcription: { model: "grok-transcribe", language_hint: "fr" }, turn_detection: null },
      output: { format: { type: "audio/pcm", rate: 8000 }, speed: 1.1 },
    },
  } });
  await s.attendre((e) => e.type === "session.updated");
  s.audio = (buf) => { for (let o = 0; o < buf.length; o += 320) s.envoyer({ type: "input_audio_buffer.append", audio: buf.subarray(o, o + 320).toString("base64") }); };
  s.reponse = async () => {
    s.texte = ""; s.premierSon = null; s.cree = null;
    const d = Date.now();
    s.envoyer({ type: "response.create" });
    const fin = await s.attendre((e) => e.type === "response.done", 20000, d);
    s.log(`=> « ${s.texte} » créée +${s.cree ? s.cree - d : "?"} ms, premier son +${s.premierSon ? s.premierSon - d : "?"} ms, statut ${fin?.response?.status}`);
    return fin;
  };
  return s;
}

// ---- 1) annuler, effacer, rejouer ----
if (!process.argv[2] || process.argv[2] === "1") {
  const s = await ouvrir("[1]");
  s.audio(DEBUT);
  s.envoyer({ type: "input_audio_buffer.commit" });
  const commit = await s.attendre((e) => e.type === "input_audio_buffer.committed");
  s.log(`commit : ${JSON.stringify(commit && Object.keys(commit))}`);
  const d = Date.now();
  s.envoyer({ type: "response.create", response: { metadata: { anticipee: "1" } } });
  const cree = await s.attendre((e) => e.type === "response.created");
  s.log(`metadata sur created : ${JSON.stringify(cree?.response?.metadata)} (+${cree ? cree._a - d : "?"} ms)`);
  const assistantItem = await s.attendre((e) => (e.type === "conversation.item.added" || e.type === "response.output_item.added") && e.item?.role === "assistant", 3000);
  await attendre(250);
  s.envoyer({ type: "response.cancel" });
  const fin = await s.attendre((e) => e.type === "response.done", 8000);
  s.log(`annulée : statut=${fin?.response?.status} metadata=${JSON.stringify(fin?.response?.metadata)} texte partiel « ${s.texte} » en ${fin ? fin._a - d : "?"} ms`);
  const aEffacer = [commit?.item_id, assistantItem?.item?.id].filter(Boolean);
  for (const id of aEffacer) s.envoyer({ type: "conversation.item.delete", item_id: id });
  for (const id of aEffacer) { const r = await s.attendre((e) => (e.type === "conversation.item.deleted" && e.item_id === id) || e.type === "error", 4000); s.log(`effacement ${id} : ${r ? r.type : "rien"}`); }
  s.audio(ENTIERE);
  s.envoyer({ type: "input_audio_buffer.commit" });
  await s.attendre((e) => e.type === "input_audio_buffer.committed");
  await s.reponse();
  await attendre(800);
  s.envoyer({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "Contrôle technique, réponds en texte simple : combien de messages je t'ai adressés dans cet appel, cite chacun mot pour mot, puis cite chacune de tes réponses mot pour mot." }] } });
  await s.reponse();
  s.ws.close();
}

const SEUL = process.argv[2];
// ---- 2) annulation dans la foulée de response.create ----
if (!SEUL || SEUL === "2") {
  const s = await ouvrir("[2]");
  s.audio(JAMBON);
  s.envoyer({ type: "input_audio_buffer.commit" });
  await s.attendre((e) => e.type === "input_audio_buffer.committed");
  s.envoyer({ type: "response.create" });
  s.envoyer({ type: "response.cancel" });
  await attendre(3000);
  s.log("relance après la course :");
  await s.reponse();
  // ---- 3) annulation sans réponse active : erreur ? gardée pour la réponse suivante ? ----
  await attendre(500);
  s.log("annulation sans réponse active :");
  s.envoyer({ type: "response.cancel" });
  await attendre(2000);
  s.audio(ENTIERE);
  s.envoyer({ type: "input_audio_buffer.commit" });
  await s.attendre((e) => e.type === "input_audio_buffer.committed", 4000, Date.now());
  s.log("réponse 2 s après l'annulation à vide :");
  await s.reponse();
  s.ws.close();
}
// ---- 4) réponse demandée sur un son très court (l'appel du 17/09 où Grok n'a jamais créé la réponse) ----
if (!SEUL || SEUL === "4") {
  const s = await ouvrir("[4]");
  for (const [nom, a, b] of [["mmm 0,8 s", 22.36, 23.18], ["souffle 0,3 s", 22.5, 22.8], ["silence 0,5 s", 19.0, 19.5]]) {
    s.log(`--- ${nom}`);
    s.audio(extrait(a, b));
    const d = Date.now();
    s.envoyer({ type: "input_audio_buffer.commit" });
    const c = await s.attendre((e) => e.type === "input_audio_buffer.committed" || e.type === "error", 3000, d);
    s.log(`commit : ${c ? c.type : "RIEN"}`);
    await s.reponse();
    await attendre(500);
  }
  s.ws.close();
}
process.exit(0);
