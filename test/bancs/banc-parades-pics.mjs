// Trois parades aux pics de Grok (2,7 a 3,7 s avant le premier son, environ une reponse sur cinq),
// une fois ecartes par mesure : relancer la reponse muette, changer de modele, format audio, vitesse.
// Le retard est au DEMARRAGE de la generation chez xAI (le premier texte arrive aussi tard que le premier son),
// donc seuls comptent : ce que Grok doit relire avant de demarrer, ce qui demarre en parallele, ce qui demarre plus tot.
//
//   rang    L'historique qui grossit au fil de l'appel fait-il monter la latence ?
//           30 tours d'affilee sur UNE session (consigne complete de Palazzo) contre 6 sessions de 5 tours.
//           Si les pics se concentrent sur les rangs eleves, la parade est d'elaguer (conversation.item.delete).
//   effort  `reasoning.effort` est pose sur session.update seulement. Un `response.create` qui porte un objet
//           `response: { instructions }` (le pont le fait pour l'accueil) repart-il en "high" par defaut ?
//           30 reponses nues contre 30 avec instructions, meme session a effort "none".
//   hedge   Les pics sont-ils INDEPENDANTS d'une session a l'autre ? Deux sessions identiques recoivent la meme
//           question au meme instant. Si oui, demander a une doublure quand la primaire est muette depuis 1,3 s
//           ramene P(lent) de ~20 % a ~4 %. Mesure : latence de A, de B, et de min(A, B).
//
// Usage : node test/bancs/banc-parades-pics.mjs [rang|effort|hedge|tout] [N]
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { createPizzeria } from "../../lib/pizzeria.js";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(ICI, "fixtures");
const vault = fs.readFileSync(process.env.VAULT || "C:/Users/msi/.secrets/api-keys.env", "utf8");
const CLE = (vault.match(/^XAI_API_KEY=(.*)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
const EPREUVE = process.argv[2] || "tout";
const N = Number(process.argv[3] || 30);
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

const session = JSON.parse(fs.readFileSync(path.join(FIXTURES, "session-palazzo.json"), "utf8"));
const pizzeria = createPizzeria({ menuFile: path.join(ICI, "../../menus/palazzo.json"), dataFile: "", capaciteParQuart: 15, reserveParQuart: 0, delaiMinMinutes: 20, maxPizzas: 20, services: "11:30-14:30,18:30-22:30", timeZone: "Europe/Paris", distant: null });
const LONGUE = `${session.instructions}\n\n# Contexte de cet appel\n${pizzeria.contexteAppel()}\nLa carte complete et a jour, avec les prix, est ci-dessous.\n\n${pizzeria.carteTexte()}`;
const OUTILS = [...pizzeria.tools, ...(session.tools || [])];

// Questions variees, sans outil a appeler : on mesure le demarrage de la generation, pas la boucle d'outils.
const QUESTIONS = [
  "Bonjour, qu'est-ce que vous avez comme pizza avec du jambon ?",
  "Est-ce que vous faites des pizzas sans gluten ?",
  "Vous etes ouverts jusqu'a quelle heure ce soir ?",
  "Il y a quoi sur la Regina ?",
  "Vous etes bien route de Montpellier ?",
  "C'est combien la plus grande pizza ?",
  "Vous avez des desserts ?",
  "Est-ce qu'il y a du piment sur la Diavola ?",
];

function percentile(tab, p) {
  const t = tab.slice().sort((a, b) => a - b);
  return t.length ? t[Math.min(t.length - 1, Math.floor(t.length * p))] : null;
}
const resume = (nom, sons) => {
  const pics = sons.filter((s) => s >= 2000);
  console.log(`${nom.padEnd(22)} n=${String(sons.length).padStart(3)}  mediane ${String(percentile(sons, 0.5)).padStart(5)} ms  p75 ${String(percentile(sons, 0.75)).padStart(5)}  p90 ${String(percentile(sons, 0.9)).padStart(5)}  max ${String(Math.max(...sons)).padStart(5)}  pics>2s ${pics.length}/${sons.length} (${Math.round((100 * pics.length) / sons.length)} %)`);
};

async function ouvrir({ longue = true, effort = "none" } = {}) {
  const tok = await fetch("https://api.x.ai/v1/realtime/client_secrets", { method: "POST", headers: { Authorization: `Bearer ${CLE}`, "Content-Type": "application/json" }, body: JSON.stringify({ expires_after: { seconds: 900 } }) }).then((r) => r.json());
  const ws = new WebSocket("wss://api.x.ai/v1/realtime?model=grok-voice-latest", [`xai-client-secret.${tok.value || tok.client_secret?.value}`]);
  await new Promise((ok) => { ws.onopen = ok; });
  const evts = [];
  ws.onmessage = (m) => { const e = JSON.parse(m.data); e._a = Date.now(); evts.push(e); };
  ws.send(JSON.stringify({ type: "session.update", session: {
    instructions: longue ? LONGUE : "Tu es Chiara, au telephone chez Palazzo Pizza. Reponses tres courtes, une phrase.",
    ...(longue ? { tools: OUTILS, tool_choice: "auto" } : {}),
    voice: "carina", reasoning: { effort },
    audio: { input: { format: { type: "audio/pcm", rate: 8000 }, transcription: { model: "grok-transcribe", language_hint: "fr" }, turn_detection: null }, output: { format: { type: "audio/pcm", rate: 8000 }, speed: 1.1 } },
  } }));
  for (let i = 0; i < 100 && !evts.some((e) => e.type === "session.updated"); i++) await attendre(100);
  return { ws, evts };
}

// Pose une question ecrite et mesure le premier son. `instructions` non vide = response.create porte un objet.
async function tour({ ws, evts }, texte, instructions = null, effort = null) {
  const avant = evts.length;
  ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: texte }] } }));
  const d = Date.now();
  const reponse = { ...(instructions ? { instructions } : {}), ...(effort ? { reasoning: { effort } } : {}) };
  ws.send(JSON.stringify(Object.keys(reponse).length ? { type: "response.create", response: reponse } : { type: "response.create" }));
  let fin = null;
  for (let k = 0; k < 600 && !fin; k++) { await attendre(25); fin = evts.slice(avant).find((e) => e.type === "response.done"); }
  const ev = evts.slice(avant);
  const t = (type) => { const e = ev.find((x) => x.type === type); return e ? e._a - d : null; };
  // Une reponse qui appelle un outil recoit un resultat neutre, pour garder la conversation valide.
  for (const e of ev.filter((x) => x.type === "response.function_call_arguments.done")) ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: e.call_id, output: JSON.stringify({ ok: true }) } }));
  return { son: t("response.output_audio.delta"), cree: t("response.created"), texte1: t("response.output_audio_transcript.delta"), outil: ev.some((x) => x.type === "response.function_call_arguments.done") };
}

// ---- rang : l'historique qui grossit ----
async function epreuveRang() {
  console.log(`\n=== rang : ${N} tours d'affilee sur une session contre ${Math.ceil(N / 5)} sessions de 5 tours (consigne ${LONGUE.length} car) ===`);
  const s = await ouvrir();
  const longs = [];
  for (let i = 0; i < N; i++) { const r = await tour(s, QUESTIONS[i % QUESTIONS.length]); longs.push({ rang: i + 1, ...r }); await attendre(300); }
  s.ws.close();
  const courts = [];
  for (let b = 0; b < Math.ceil(N / 5); b++) {
    const c = await ouvrir();
    for (let i = 0; i < 5; i++) { const r = await tour(c, QUESTIONS[(b * 5 + i) % QUESTIONS.length]); courts.push({ rang: i + 1, ...r }); await attendre(300); }
    c.ws.close();
  }
  const sons = (l) => l.map((x) => x.son).filter((x) => x != null);
  resume("session longue", sons(longs));
  resume("sessions de 5 tours", sons(courts));
  for (const [a, b] of [[1, 10], [11, 20], [21, 30]]) {
    const part = sons(longs.filter((x) => x.rang >= a && x.rang <= b));
    if (part.length) resume(`  rangs ${a}-${b}`, part);
  }
  console.log(`  premiers sons dans l'ordre : ${longs.map((l) => (l.son ?? "-") + (l.outil ? "*" : "")).join(" ")}`);
}

// ---- effort : response.create nu contre response.create avec instructions ----
// Trois branches alternees sur la MEME session (a effort "none"), pour que l'historique et l'heure
// ne favorisent aucune : nu, avec un objet `response: { instructions }`, et le meme objet qui REPOSE
// `reasoning: { effort: "none" }`. Si la branche 2 est nettement plus lente et que la 3 revient au
// niveau de la 1, l'objet response repart en effort par defaut et il faut y remettre reasoning.
async function epreuveEffort() {
  console.log(`\n=== effort : ${N} x 3 reponses (nue / instructions / instructions+reasoning), session a effort "none" ===`);
  const s = await ouvrir();
  const INSTR = "Reponds en une phrase courte, avec le sourire.";
  const branches = [
    { nom: "response.create nu", instr: null, effort: null, sons: [] },
    { nom: "+ instructions", instr: INSTR, effort: null, sons: [] },
    { nom: "+ instr + reasoning", instr: INSTR, effort: "none", sons: [] },
  ];
  for (let i = 0; i < N; i++) {
    for (const b of branches) {
      const r = await tour(s, QUESTIONS[(i * 3 + branches.indexOf(b)) % QUESTIONS.length], b.instr, b.effort);
      if (r.son != null) b.sons.push(r.son);
      await attendre(300);
    }
  }
  s.ws.close();
  for (const b of branches) resume(b.nom, b.sons);
  console.log(`  ordre nu             : ${branches[0].sons.join(" ")}`);
  console.log(`  ordre instructions   : ${branches[1].sons.join(" ")}`);
  console.log(`  ordre instr+reasoning: ${branches[2].sons.join(" ")}`);
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
  const deuxLentes = smin.filter((s) => s >= 2000).length;
  console.log(`  les DEUX lentes : ${deuxLentes}/${smin.length}. Si c'est nettement sous le carre du taux d'une seule, les pics sont independants et la doublure paie.`);
}

// ---- injection : peut-on poser dans une session une reponse qu'elle n'a pas produite ? ----
// C'est ce qui decide si la doublure est realisable en production. Les deux sessions doivent garder le MEME
// historique : quand l'une repond, l'autre doit recevoir son texte comme si elle l'avait dit. On verifie que
// `conversation.item.create` avec role "assistant" est accepte, et surtout que le modele en TIENT COMPTE
// (il ne doit pas redire ce que l'autre vient de dire, et doit pouvoir s'y referer).
async function epreuveInjection() {
  console.log("\n=== injection : une reponse posee dans une session qui ne l'a pas produite ===");
  const s = await ouvrir({ longue: false });
  const dire = (texte) => s.ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: texte }] } }));
  const avant = s.evts.length;
  s.ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "Bonjour, c'est pour commander." }] } }));
  dire("Bonjour ! La Regina est a onze euros et la Diavola a douze. Laquelle vous tente ?");
  await attendre(1200);
  // Un fait que le modele ne peut pas deviner : s'il le redit, c'est qu'il a vraiment lu l'item injecte.
  dire("C'est note. Votre commande porte le numero 4712, a retirer a 20h05.");
  await attendre(1200);
  const err = s.evts.slice(avant).filter((e) => e.type === "error");
  const types = [...new Set(s.evts.slice(avant).map((e) => e.type))];
  console.log(`  erreurs : ${err.length}${err.length ? " -> " + err.map((e) => e.error?.message || JSON.stringify(e)).join(" | ") : ""}`);
  console.log(`  evenements recus : ${types.join(", ") || "aucun"}`);
  const r = await tour(s, "Pardon, vous m'avez donne quel numero de commande, et pour quelle heure ?");
  const texte = s.evts.filter((e) => e.type === "response.output_audio_transcript.done").map((e) => e.transcript).join(" ");
  console.log(`  premier son ${r.son} ms, reponse : « ${texte.slice(-240)} »`);
  console.log(`  verdict : ${/4712/.test(texte) && /20\s*h?\s*0?5|vingt heures/i.test(texte) ? "INJECTION LUE (numero et heure redits) -> doublure faisable" : "le modele n'a pas relu l'item injecte -> chercher une autre facon de synchroniser"}`);
  s.ws.close();
}

// ---- reprise : apres une reponse ANNULEE puis remplacee par celle de la doublure, la primaire repete-t-elle ? ----
// C'est le defaut vu sur deux appels reels : la doublure repond, son texte est injecte dans la primaire, et au
// tour suivant la primaire redit la meme chose. Hypothese : la reponse annulee laisse un item assistant partiel,
// que le modele voit comme « commence, jamais fini », et qu'il reprend. On compare deux facons de faire.
async function epreuveReprise() {
  console.log("\n=== reprise : la primaire repete-t-elle la reponse de la doublure ? ===");
  const TEXTE_DOUBLURE = "Non, nous ne faisons pas de pizzas sans gluten. Il faudrait un poste de preparation separe pour eviter la contamination, et nous n'en avons pas. Vous desirez autre chose ?";
  for (const effacer of [false, true]) {
    const s = await ouvrir({ longue: false });
    // Tour 1 : le client demande, la primaire commence a repondre, on l'annule en cours de generation.
    s.ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "Est-ce que vous faites des pizzas sans gluten ?" }] } }));
    const avant = s.evts.length;
    s.ws.send(JSON.stringify({ type: "response.create" }));
    for (let i = 0; i < 40 && !s.evts.slice(avant).some((e) => e.type === "response.output_audio.delta"); i++) await attendre(50);
    s.ws.send(JSON.stringify({ type: "response.cancel" }));
    for (let i = 0; i < 60 && !s.evts.slice(avant).some((e) => e.type === "response.done"); i++) await attendre(50);
    // Les elements que cette reponse annulee a laisses dans la conversation.
    const items = s.evts.slice(avant).filter((e) => e.type === "conversation.item.added" && e.item?.role !== "user").map((e) => e.item?.id).filter(Boolean);
    if (effacer) for (const id of items) s.ws.send(JSON.stringify({ type: "conversation.item.delete", item_id: id }));
    await attendre(400);
    // Ce que la doublure a reellement dit au client.
    s.ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: TEXTE_DOUBLURE }] } }));
    await attendre(400);
    // Tour 2 : le client passe a autre chose. La primaire doit repondre a CA, pas redire le gluten.
    const r = await tour(s, "D'accord. Et vous avez des desserts ?");
    const texte = s.evts.filter((e) => e.type === "response.output_audio_transcript.done").map((e) => e.transcript).join(" | ");
    const dernier = texte.split(" | ").pop() || "";
    const repete = /gluten|contamination|poste de pr/i.test(dernier);
    console.log(`  ${effacer ? "items annules EFFACES " : "items annules GARDES  "} : ${items.length} item(s), premier son ${r.son} ms`);
    console.log(`    reponse : « ${dernier.slice(0, 180)} »`);
    console.log(`    ${repete ? "REPETE la reponse de la doublure" : "enchaine correctement"}`);
    s.ws.close();
  }
}

// ---- avide : que fait Grok quand on lui demande une reponse SANS nouvelle entree du client ? ----
// Le pont valide un tour des que le client a fait assez de bruit, meme si ce bruit ne porte aucun mot (« mmm »,
// un souffle) : un tel commit ne cree AUCUN message (point 5 du § 7 bis), et le `response.create` part quand meme.
async function epreuveAvide() {
  console.log("\n=== avide : une reponse demandee sans nouvelle entree du client ===");
  const s = await ouvrir({ longue: false });
  const r1 = await tour(s, "Est-ce que vous faites des pizzas sans gluten ?");
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
  console.log("  si elle redit le 1er tour, c'est la cause de la repetition : ne jamais demander de reponse sans entree nouvelle.");
  s.ws.close();
}

if (EPREUVE === "avide" || EPREUVE === "tout") await epreuveAvide();
if (EPREUVE === "reprise" || EPREUVE === "tout") await epreuveReprise();
if (EPREUVE === "injection" || EPREUVE === "tout") await epreuveInjection();
if (EPREUVE === "rang" || EPREUVE === "tout") await epreuveRang();
if (EPREUVE === "effort" || EPREUVE === "tout") await epreuveEffort();
if (EPREUVE === "hedge" || EPREUVE === "tout") await epreuveHedge();
process.exit(0);
