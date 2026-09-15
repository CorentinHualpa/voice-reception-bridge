// Banc "sur le fond" de l'agent Palazzo, SANS audio : Grok Voice realtime en mode texte, avec le
// vrai prompt et les VRAIS outils (lib/pizzeria.js), face a des clients simules (OpenAI).
// L'horloge est figee a 19:00 heure de Paris pour que les heures de retrait soient comparables.
//
// Usage : node test/palazzo-test.mjs              (tous les personas)
//         node test/palazzo-test.mjs robot allergie (certains)
// Cles XAI + OPENAI lues dans le vault, jamais affichees.

import fs from "fs";
import path from "path";
import WebSocket from "ws";
import { createPizzeria } from "../lib/pizzeria.js";

const vault = fs.readFileSync("C:/Users/msi/.secrets/api-keys.env", "utf8");
const key = (k) => (vault.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim().replace(/^["']|["']$/g, "") || "";
const XAI_API_KEY = key("XAI_API_KEY"), OPENAI_API_KEY = key("OPENAI_API_KEY");
const GROK_MODEL = process.env.GROK_MODEL || "grok-voice-latest";
const HORLOGE = new Date(process.env.HORLOGE || "2026-09-15T17:00:00Z");

const PERSONAS = [
  { id: "simple", brief: "Tu t'appelles Julien. Tu veux une Regina et une Capri à emporter. Si on te propose un dessert ou une boisson, tu prends un tiramisu. Tu veux passer vers 20 heures. Tu es sympa et direct." },
  { id: "supplements", brief: "Tu t'appelles Nadia. Tu demandes d'abord ce qu'il y a dans l'Etna. Puis tu commandes une Bari avec un supplément burrata et une Veggie sans oignons. Tu refuses le dessert et la boisson. Tu veux la commande le plus tôt possible." },
  { id: "robot", brief: "Tu t'appelles Gérard, 70 ans. Dès le début tu demandes si tu parles à un robot ou à une vraie personne, un peu méfiant. Quand on te répond, tu acceptes quand même de commander une Margherita, pour 20h30. Pas de dessert." },
  { id: "allergie", brief: "Tu t'appelles Clara. Ton fils est allergique aux fruits à coque (noisettes, pistaches). Tu demandes si la Capri et la Bellucci sont sans danger pour lui et s'il y a un risque de traces. Tu veux une réponse sûre avant de commander." },
  { id: "livraison", brief: "Tu veux te faire livrer deux pizzas chez toi à Lattes, tu demandes si le restaurant livre. Tu n'as pas de voiture. Tu ne commandes pas à emporter." },
  { id: "groupe", brief: "Tu t'appelles Mehdi. Tu organises un anniversaire samedi et tu veux commander trente pizzas pour 19 heures. Tu donnes ton prénom si on te le demande." },
  { id: "anglais", brief: "You ONLY speak English. You are a tourist. You want to order one Parma pizza and one San Pellegrino for pickup as soon as possible. Your name is Tom. Keep speaking English the whole time." },
  { id: "heure-pleine", pre: [{ prenom: "Luc", heure_retrait: "19:30", articles: [{ produit: "Roma", quantite: 15 }] }, { prenom: "Ana", heure_retrait: "19:30", articles: [{ produit: "Capri", quantite: 15 }] }], brief: "Tu t'appelles Sophie. Tu veux quatre Fiorella pour 19h30 précises. Si on te dit que ce n'est pas possible, tu acceptes l'heure proposée. Pas de dessert." },
  { id: "formule-soir", brief: "Tu t'appelles Paul. Tu veux la formule midi Pizz&Sweet parce que c'est moins cher, même si c'est le soir. Si on refuse, tu prends une Fiorella et une Limonata pour 20 heures." },
  { id: "sans-gluten", brief: "Tu t'appelles Marion. Tu es intolérante au gluten et tu demandes s'ils font des pizzas sans gluten. Si ce n'est pas possible, tu demandes s'ils font du halal pour ton mari, puis tu remercies et tu raccroches sans commander." },
  { id: "pratique", brief: "Tu t'appelles Hugo. Avant de commander, tu demandes où te garer, puis si tu peux payer en tickets restaurant. Ensuite tu commandes une Rucola pour le plus tôt possible, sans dessert." },
  { id: "reservation", brief: "Tu t'appelles Élodie. Tu veux réserver une table pour quatre personnes samedi à 20 heures. Tu donnes ton prénom si on te le demande." },
  { id: "ecorche", brief: "Tu t'appelles Karim. Tu écorches les noms : tu demandes une « Patino » et une « Selentina ». Puis tu demandes si on peut remplacer la mortadelle de la Bellucci par du jambon blanc, et tu en prends une comme ça. Tu prends une Moretti. Pour 20h30." },
  { id: "robot-bis", brief: "Tu t'appelles Denise. Tu demandes d'emblée si c'est une machine, tu dis que tu n'aimes pas trop ça, puis tu commandes quand même deux Roma pour 21 heures. Pas de dessert. Tu confirmes le récapitulatif." },
  { id: "changement", brief: "Tu t'appelles Inès. Tu commandes une Salmon Joe pour 20h15. Au moment du récapitulatif, tu changes d'avis : tu veux finalement deux Salmon Joe. Pas de dessert." },
];

const CALLER_SYS = (p) => `Tu joues un client qui téléphone à la pizzeria Palazzo Pizza (Saint-Jean-de-Védas) un soir vers 19 heures. Tu tombes sur l'assistante téléphonique.
PERSONA: ${p.brief}
RÈGLES:
- Phrases courtes et naturelles comme à l'oral au téléphone. Une information à la fois.
- Tu ne joues QUE le client.
- Tu réagis à ce que l'assistante vient de dire.
- Dès que l'assistante te souhaite une bonne soirée pour conclure, ou que ton besoin est traité, tu raccroches en répondant UNIQUEMENT [RACCROCHE].
- Jamais de guillemets autour de tes répliques.`;

async function callerTurn(p, dialog) {
  const messages = [{ role: "system", content: CALLER_SYS(p) }];
  for (const t of dialog) if (t.who !== "Outil") messages.push({ role: t.who === "Agent" ? "user" : "assistant", content: t.msg });
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0.6, messages }),
  }).then((x) => x.json()).catch(() => null);
  return r?.choices?.[0]?.message?.content?.trim() || "[RACCROCHE]";
}

async function run(p) {
  const pizzeria = createPizzeria({ menuFile: "menus/palazzo.json", maintenant: () => HORLOGE });
  for (const [i, c] of (p.pre || []).entries()) pizzeria.run("enregistrer_commande", c, { callSid: `pre-${i}` });
  const prompt = fs.readFileSync("prompts/palazzo.txt", "utf8").replace("{{CARTE}}", pizzeria.carteTexte());
  const instructions = `${prompt}\n\n# Contexte de cet appel\n${pizzeria.contexteAppel()}`;

  const tok = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
    method: "POST", headers: { Authorization: `Bearer ${XAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expires_after: { seconds: 600 } }),
  }).then((r) => r.json());
  const token = tok.value || tok.secret || tok.token || tok.client_secret?.value;
  const grok = new WebSocket(`wss://api.x.ai/v1/realtime?model=${GROK_MODEL}`, [`xai-client-secret.${token}`]);
  const dialog = [];
  let onDone = null, buf = "", calls = [];

  grok.on("message", (raw) => {
    let e; try { e = JSON.parse(raw.toString()); } catch { return; }
    if (e.type === "ping") grok.send(JSON.stringify({ type: "pong", ...(e.event_id ? { event_id: e.event_id } : {}) }));
    else if (e.type === "response.output_audio_transcript.delta" || e.type === "response.output_text.delta") buf += e.delta || "";
    else if (e.type === "response.function_call_arguments.done") calls.push(e);
    else if (e.type === "response.done" && onDone) { const f = onDone; onDone = null; f(); }
    else if (e.type === "error") console.error("  [grok error]", JSON.stringify(e.error || e).slice(0, 300));
  });
  await new Promise((res, rej) => { grok.on("open", res); grok.on("error", rej); });
  grok.send(JSON.stringify({ type: "session.update", session: {
    instructions, tools: pizzeria.tools, tool_choice: "auto", voice: "eve",
    reasoning: { effort: process.env.GROK_REASONING || "high" },
    turn_detection: { type: "server_vad", threshold: 0.6 },
    audio: { input: { format: { type: "audio/pcm", rate: 24000 } }, output: { format: { type: "audio/pcm", rate: 24000 } } },
  } }));
  await new Promise((r) => setTimeout(r, 1500));

  const oneResponse = () => new Promise((res) => {
    const t = setTimeout(() => { onDone = null; res(); }, 45000);
    onDone = () => { clearTimeout(t); res(); };
    grok.send(JSON.stringify({ type: "response.create" }));
  });
  // Un tour agent = reponses successives tant que le modele appelle des outils (plafond comme en prod).
  let gardeFaite = false;
  let recap = false, clientApresRecap = false; // miroir de la garde du pont (server.js RECAP_RE)
  const RECAP_RE = /c'est bien ça|c'est correct|est-ce (bien )?(correct|ça)|je récapitule|récapitul|ça vous va|is that (right|correct)|does that sound|es correcto|está bien así|è corretto|va bene così/i;
  async function agentTurn() {
    for (let relance = 0; relance <= 4; relance++) {
      buf = ""; calls = [];
      await oneResponse();
      if (buf.trim()) dialog.push({ who: "Agent", msg: buf.trim() });
      if (RECAP_RE.test(buf) || (/euro/i.test(buf) && /\?/.test(buf))) { recap = true; clientApresRecap = false; }
      if (!calls.length) {
        const consigne = !gardeFaite && pizzeria.consigneCloture(buf, { callSid: "banc", outils: [] });
        if (!consigne) return;
        gardeFaite = true;
        dialog.push({ who: "Garde", msg: "commande annoncée sans enregistrement, consigne renvoyée" });
        grok.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: consigne }] } }));
        continue;
      }
      for (const c of calls) {
        let args = {}; try { args = JSON.parse(c.arguments || "{}"); } catch {}
        if (c.name === "chiffrer_commande") { recap = false; clientApresRecap = false; }
        const out = pizzeria.run(c.name, args, { callSid: "banc", from: "0612345678", recapConfirme: recap && clientApresRecap });
        dialog.push({ who: "Outil", msg: `${c.name} ${JSON.stringify(args)} -> ${JSON.stringify(out)}` });
        grok.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: c.call_id, output: JSON.stringify(out) } }));
      }
    }
  }

  await agentTurn();
  for (let i = 0; i < 14; i++) {
    const msg = await callerTurn(p, dialog);
    if (/\[RACCROCHE\]/i.test(msg)) break;
    dialog.push({ who: "Client", msg });
    if (recap) clientApresRecap = true;
    grok.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: msg }] } }));
    await agentTurn();
  }
  grok.close();
  return { dialog, commandes: pizzeria.commandes().filter((c) => c.callSid === "banc"), messages: pizzeria.messages() };
}

const only = process.argv.slice(2);
const list = only.length ? PERSONAS.filter((p) => only.includes(p.id)) : PERSONAS;
const outDir = path.join("test", "results", process.env.RESULTS_LABEL || "palazzo");
fs.mkdirSync(outDir, { recursive: true });
await Promise.all(list.map(async (p) => {
  try {
    const r = await run(p);
    const txt = r.dialog.map((l) => `${l.who} : ${l.msg}`).join("\n")
      + `\n\n--- commandes enregistrées : ${JSON.stringify(r.commandes.map((c) => ({ prenom: c.prenom, heure: c.heure_retrait, total: c.total_eur, lignes: c.lignes.map((l) => `${l.quantite} ${l.produit}${l.supplements.length ? " +" + l.supplements.join("+") : ""}${l.retraits.length ? " sans " + l.retraits.join(",") : ""}`) })))}`
      + `\n--- messages transmis : ${JSON.stringify(r.messages)}`;
    fs.writeFileSync(path.join(outDir, `${p.id}.txt`), txt, "utf8");
    console.log(`${p.id} : ${r.dialog.length} lignes, ${r.commandes.length} commande(s), ${r.messages.length} message(s)`);
  } catch (e) { console.log(`${p.id} : ECHEC ${e.message}`); }
}));
