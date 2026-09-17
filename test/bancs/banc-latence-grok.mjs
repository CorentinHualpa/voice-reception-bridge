// Banc de latence Grok Voice sur la session réelle de Palazzo : temps jusqu'au premier son, avec et sans la
// carte dans le contexte, en alternance pour neutraliser la charge du moment. Tours en TEXTE (pas de VAD) :
// on mesure la génération seule. Clé xAI lue dans le vault, jamais affichée.
// Usage : node banc-latence-grok.mjs [paires=4]
import path from "node:path";
import { fileURLToPath } from "node:url";
const ICI = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(ICI, "fixtures");
import fs from "node:fs";
import { createPizzeria } from "../../lib/pizzeria.js";

const S = process.env.BANC_SORTIE || path.join(ICI, ".sorties");
fs.mkdirSync(S, { recursive: true });
const PAIRES = Number(process.argv[2] || 4);
const vault = fs.readFileSync(process.env.VAULT || "C:/Users/msi/.secrets/api-keys.env", "utf8");
const CLE = (vault.match(/^XAI_API_KEY=(.*)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
const session = JSON.parse(fs.readFileSync(`${process.env.BANC_SESSION || path.join(FIXTURES, "session-palazzo.json")}`, "utf8"));
const pizzeria = createPizzeria({ menuFile: path.join(ICI, "../../menus/palazzo.json") });
const carte = pizzeria.carteTexte();
const EXTRAIT_KB = carte.split("\n").filter((l) => /jambon/i.test(l)).join("\n");

function instructions(avecCarte) {
  const ctx = [pizzeria.contexteAppel(), "Le client appelle depuis le numéro 06 12 34 56 78."];
  if (avecCarte) ctx.push(`La carte complète et à jour, avec les prix, est ci-dessous. Pour une question sur les pizzas, les formules, les desserts, les boissons, leurs ingrédients ou leurs prix, réponds directement à partir d'elle, sans outil de recherche et sans annoncer que tu vérifies.\n\n${carte}`);
  return `${session.instructions}\n\n# Contexte de cet appel\n${ctx.join("\n")}`;
}

async function uneSession(avecCarte) {
  const tok = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${CLE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expires_after: { seconds: 300 } }),
  }).then((r) => r.json());
  const secret = tok.value || tok.secret || tok.token || tok.client_secret?.value;
  const ws = new WebSocket(`wss://api.x.ai/v1/realtime?model=${session.model || "grok-voice-latest"}`, [`xai-client-secret.${secret}`]);
  const mesures = [];
  let attente = null; // { nom, t0, premierSon, outils, resolve }
  const envoyer = (o) => ws.send(JSON.stringify(o));
  const tour = (nom, evenements) => new Promise((resolve) => {
    attente = { nom, t0: Date.now(), premierSon: null, outils: [], resolve };
    for (const e of evenements) envoyer(e);
  });
  await new Promise((ok, ko) => { ws.onopen = ok; ws.onerror = (e) => ko(new Error("ws " + (e?.message || "erreur"))); });
  const pret = new Promise((ok) => {
    ws.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === "session.updated") ok();
      else if (e.type === "error") console.log("  erreur", JSON.stringify(e.error || e).slice(0, 200));
      else if (!attente) return;
      else if (e.type === "response.output_audio.delta" && attente.premierSon == null) attente.premierSon = Date.now() - attente.t0;
      else if (e.type === "response.function_call_arguments.done") attente.outils.push({ name: e.name, callId: e.call_id });
      else if (e.type === "response.done") {
        const a = attente; attente = null;
        a.resolve({ nom: a.nom, premierSon: a.premierSon, total: Date.now() - a.t0, outils: a.outils });
      }
    };
  });
  envoyer({
    type: "session.update",
    session: {
      instructions: instructions(avecCarte),
      tools: [...pizzeria.tools, ...(session.tools || [])],
      tool_choice: "auto",
      voice: session.voice || "eve",
      reasoning: { effort: session.reasoning === "high" ? "high" : "none" },
      turn_detection: { type: null },
      audio: { input: { format: { type: "audio/pcm", rate: 8000 } }, output: { format: { type: "audio/pcm", rate: 8000 }, speed: Number(session.speed) || 1 } },
    },
  });
  await pret;
  const accueil = String(session.greeting || "Pizza Palazzo bonjour, que désirez-vous commander ?");
  mesures.push(await tour("accueil", [{ type: "response.create", response: { instructions: `Dis exactement cette phrase, mot pour mot, sans rien ajouter avant ni apres, puis ecoute : « ${accueil} »` } }]));
  const question = async (nom, texte) => {
    let r = await tour(nom, [
      { type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: texte }] } },
      { type: "response.create" },
    ]);
    mesures.push(r);
    for (let relance = 0; r.outils.length && relance < 2; relance++) {
      const evts = r.outils.map((o) => ({ type: "conversation.item.create", item: { type: "function_call_output", call_id: o.callId, output: JSON.stringify(o.name === "search_knowledge_base" ? { result: EXTRAIT_KB } : { ok: true }) } }));
      r = await tour(`${nom}+outil`, [...evts, { type: "response.create" }]);
      mesures.push(r);
    }
  };
  await question("jambon", "Bonjour, qu'est-ce que vous avez comme pizzas avec du jambon ?");
  await question("gluten", "Est-ce que vous faites des pizzas sans gluten ?");
  ws.close();
  return mesures;
}

const lignes = [];
for (let i = 0; i < PAIRES; i++) {
  for (const avecCarte of [false, true]) {
    try {
      const m = await uneSession(avecCarte);
      const texte = m.map((x) => `${x.nom}=${x.premierSon ?? "-"}ms${x.outils.length ? "[" + x.outils.map((o) => o.name).join(",") + "]" : ""}`).join("  ");
      console.log(`${avecCarte ? "AVEC carte" : "SANS carte"}  ${texte}`);
      lignes.push({ avecCarte, m });
    } catch (err) {
      console.log(`${avecCarte ? "AVEC" : "SANS"} échec : ${err.message}`);
    }
  }
}
const med = (arr) => { const t = arr.filter((x) => x != null).sort((a, b) => a - b); return t.length ? t[Math.floor(t.length / 2)] : null; };
for (const avecCarte of [false, true]) {
  const par = {};
  for (const l of lignes.filter((x) => x.avecCarte === avecCarte)) for (const x of l.m) (par[x.nom] ??= []).push(x.premierSon);
  console.log(`médianes ${avecCarte ? "AVEC" : "SANS"} : ` + Object.entries(par).map(([k, v]) => `${k}=${med(v)}ms (n=${v.length})`).join("  "));
}
