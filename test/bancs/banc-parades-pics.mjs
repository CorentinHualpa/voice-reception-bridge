// Les parades aux pics de Grok (2,7 a 3,7 s avant le premier son, environ une reponse sur cinq), portees de
// Palazzo et rejouees sur l'agent de Dany. Le retard est au DEMARRAGE de la generation chez xAI (le premier
// texte arrive aussi tard que le premier son), donc rien de ce que fait le pont n'y change quoi que ce soit :
// relancer la reponse muette, changer de modele, le format audio et la vitesse ont tous ete ecartes par mesure.
//
//   hedge      Les pics sont-ils INDEPENDANTS d'une session a l'autre ? Deux sessions identiques recoivent la
//              meme question au meme instant. Sur Palazzo : A 0 pic sur 24 (max 1596 ms), B 2 pics (max
//              2418 ms), la premiere des deux 0 pic, max 1007 ms. Jamais les deux lentes ensemble.
//   avide      Que fait Grok quand on lui demande une reponse SANS nouvelle entree du client ? C'est ce qui
//              arrive des que le pont valide un tour sur un bruit sans mot, qui ne cree aucun message.
//   injection  Peut-on poser dans une session une reponse qu'elle n'a pas produite ? C'est ce qui decide si la
//              doublure est realisable : les deux sessions doivent garder le meme historique.
//   rang       L'historique qui grossit au fil de l'appel fait-il monter la latence ? (Sur Palazzo : non.)
//
// Usage : node test/bancs/banc-parades-pics.mjs [hedge|avide|injection|rang|tout] [N]
import { AGENT, cle } from "./config-banc.mjs";

const CLE = cle("XAI_API_KEY");
const EPREUVE = process.argv[2] || "tout";
const N = Number(process.argv[3] || 24);
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

const QUESTIONS = [
  "Bonjour, est-ce que vous depannez les pompes de relevage ?",
  "Vous intervenez dans le Val-de-Marne ?",
  "Quels sont vos horaires d'ouverture ?",
  "Combien de temps pour un devis ?",
  "Est-ce que vous vous deplacez le samedi ?",
  "Vous faites aussi l'entretien annuel ?",
  "Il faut compter combien pour un diagnostic ?",
  "Vous travaillez avec quelles marques ?",
];

function percentile(tab, p) {
  const t = tab.slice().sort((a, b) => a - b);
  return t.length ? t[Math.min(t.length - 1, Math.floor(t.length * p))] : null;
}
const resume = (nom, sons) => {
  const pics = sons.filter((s) => s >= 2000);
  console.log(`${nom.padEnd(22)} n=${String(sons.length).padStart(3)}  mediane ${String(percentile(sons, 0.5)).padStart(5)} ms  p75 ${String(percentile(sons, 0.75)).padStart(5)}  p90 ${String(percentile(sons, 0.9)).padStart(5)}  max ${String(Math.max(...sons)).padStart(5)}  pics>2s ${pics.length}/${sons.length} (${Math.round((100 * pics.length) / sons.length)} %)`);
};

async function ouvrir() {
  const tok = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${CLE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expires_after: { seconds: 900 } }),
  }).then((r) => r.json());
  const ws = new WebSocket(`wss://api.x.ai/v1/realtime?model=${AGENT.model}`, [`xai-client-secret.${tok.value || tok.client_secret?.value}`]);
  await new Promise((ok) => { ws.onopen = ok; });
  const evts = [];
  ws.onmessage = (m) => { const e = JSON.parse(m.data); e._a = Date.now(); evts.push(e); };
  ws.send(JSON.stringify({ type: "session.update", session: {
    instructions: AGENT.instructions,
    voice: AGENT.voice, reasoning: { effort: AGENT.reasoning },
    audio: { input: { format: { type: "audio/pcm", rate: 8000 }, turn_detection: null }, output: { format: { type: "audio/pcm", rate: 8000 }, speed: AGENT.speed } },
  } }));
  for (let i = 0; i < 100 && !evts.some((e) => e.type === "session.updated"); i++) await attendre(100);
  return { ws, evts };
}

async function tour({ ws, evts }, texte) {
  const avant = evts.length;
  ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: texte }] } }));
  const d = Date.now();
  ws.send(JSON.stringify({ type: "response.create" }));
  let fin = null;
  for (let k = 0; k < 600 && !fin; k++) { await attendre(25); fin = evts.slice(avant).find((e) => e.type === "response.done"); }
  const ev = evts.slice(avant);
  const t = (type) => { const e = ev.find((x) => x.type === type); return e ? e._a - d : null; };
  return { son: t("response.output_audio.delta"), cree: t("response.created") };
}

// ---- hedge : deux sessions en parallele ----
async function epreuveHedge() {
  console.log(`\n=== hedge : ${N} questions posees au MEME instant a deux sessions identiques ===`);
  const [a, b] = await Promise.all([ouvrir(), ouvrir()]);
  const sa = [], sb = [], smin = [];
  for (let i = 0; i < N; i++) {
    const q = QUESTIONS[i % QUESTIONS.length];
    const [ra, rb] = await Promise.all([tour(a, q), tour(b, q)]);
    if (ra.son != null) sa.push(ra.son);
    if (rb.son != null) sb.push(rb.son);
    if (ra.son != null && rb.son != null) smin.push(Math.min(ra.son, rb.son));
    await attendre(300);
  }
  a.ws.close(); b.ws.close();
  resume("session A seule", sa);
  resume("session B seule", sb);
  resume("premiere des deux", smin);
  console.log(`  les DEUX lentes : ${smin.filter((s) => s >= 2000).length}/${smin.length}. Nettement sous le carre du taux d'une seule = pics independants, la doublure paie.`);
}

// ---- avide : une reponse demandee sans nouvelle entree ----
async function epreuveAvide() {
  console.log("\n=== avide : une reponse demandee sans nouvelle entree du client ===");
  const s = await ouvrir();
  const r1 = await tour(s, QUESTIONS[0]);
  const t1 = (s.evts.filter((e) => e.type === "response.output_audio_transcript.done").pop() || {}).transcript || "";
  console.log(`  1er tour (${r1.son} ms) : « ${t1.slice(0, 140)} »`);
  for (const essai of [1, 2]) {
    const avant = s.evts.length;
    const d = Date.now();
    s.ws.send(JSON.stringify({ type: "response.create" })); // aucun message user ajoute
    let fin = null;
    for (let k = 0; k < 400 && !fin; k++) { await attendre(25); fin = s.evts.slice(avant).find((e) => e.type === "response.done"); }
    const son = s.evts.slice(avant).find((e) => e.type === "response.output_audio.delta");
    const txt = (s.evts.slice(avant).filter((e) => e.type === "response.output_audio_transcript.done").pop() || {}).transcript || "";
    console.log(`  demande a vide n°${essai} (${son ? son._a - d + " ms" : "aucun son"}) : « ${txt.slice(0, 140) || "(rien)"} »`);
  }
  console.log("  si elle redit le 1er tour, c'est la cause des repetitions : ne jamais demander de reponse sans entree nouvelle.");
  s.ws.close();
}

// ---- injection : poser dans une session une reponse qu'elle n'a pas produite ----
async function epreuveInjection() {
  console.log("\n=== injection : une reponse posee dans une session qui ne l'a pas produite ===");
  const s = await ouvrir();
  const dire = (texte) => s.ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: texte }] } }));
  s.ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "Bonjour, c'est pour un depannage." }] } }));
  const avant = s.evts.length;
  dire("C'est note. Votre demande porte le numero 4712, un technicien vous rappelle avant 17h05.");
  await attendre(1200);
  const err = s.evts.slice(avant).filter((e) => e.type === "error");
  console.log(`  erreurs : ${err.length}${err.length ? " -> " + err.map((e) => e.error?.message || JSON.stringify(e)).join(" | ") : ""}`);
  console.log(`  evenements recus : ${[...new Set(s.evts.slice(avant).map((e) => e.type))].join(", ") || "aucun"}`);
  const r = await tour(s, "Pardon, vous m'avez donne quel numero, et pour quelle heure ?");
  const texte = s.evts.filter((e) => e.type === "response.output_audio_transcript.done").map((e) => e.transcript).join(" ");
  console.log(`  premier son ${r.son} ms, reponse : « ${texte.slice(-240)} »`);
  console.log(`  verdict : ${/4712/.test(texte) ? "INJECTION LUE -> doublure faisable" : "le modele n'a pas relu l'item injecte"}`);
  s.ws.close();
}

// ---- rang : l'historique qui grossit ----
async function epreuveRang() {
  console.log(`\n=== rang : ${N} tours d'affilee sur une session (consigne ${AGENT.instructions.length} car) ===`);
  const s = await ouvrir();
  const lignes = [];
  for (let i = 0; i < N; i++) { const r = await tour(s, QUESTIONS[i % QUESTIONS.length]); lignes.push({ rang: i + 1, ...r }); await attendre(300); }
  s.ws.close();
  const sons = (l) => l.map((x) => x.son).filter((x) => x != null);
  resume("session longue", sons(lignes));
  for (const [a, b] of [[1, 8], [9, 16], [17, 24]]) {
    const part = sons(lignes.filter((x) => x.rang >= a && x.rang <= b));
    if (part.length) resume(`  rangs ${a}-${b}`, part);
  }
  console.log(`  premiers sons dans l'ordre : ${lignes.map((l) => l.son ?? "-").join(" ")}`);
}

if (EPREUVE === "hedge" || EPREUVE === "tout") await epreuveHedge();
if (EPREUVE === "avide" || EPREUVE === "tout") await epreuveAvide();
if (EPREUVE === "injection" || EPREUVE === "tout") await epreuveInjection();
if (EPREUVE === "rang" || EPREUVE === "tout") await epreuveRang();
process.exit(0);
