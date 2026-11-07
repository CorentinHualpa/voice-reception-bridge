// Banc des PARCOURS de Dale Voz au téléphone (07/11/2026), sans réseau externe ni appel réel.
// server.js tourne sur ce poste ; ce script joue Twilio (Media Streams), la plateforme Dale Voz (faux serveur HTTP)
// et le modèle temps réel (faux Grok, puis faux Eleven). Il prouve :
//   1. un outil qui rend `reconfigurer: true` fait RELIRE /api/voice/session-config, puis rejouer session.update
//      (nouvelle consigne, nouveau catalogue, même voix) AVANT le function_call_output, puis relancer le modèle ;
//   2. un outil sans `reconfigurer` ne relit rien et ne rejoue rien (comportement inchangé) ;
//   3. un catalogue d'étape VIDE remplace l'ancien (`tools: []`), il ne le garde pas ;
//   4. une relecture qui échoue rend une erreur au modèle au lieu d'appliquer l'étape à moitié.
// node test/parcours-test.mjs
import assert from "assert";
import http from "http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { demandeReconfiguration } from "../lib/dalevoz.js";

const ICI = path.dirname(fileURLToPath(import.meta.url));
let ok = 0;
const cas = async (nom, fn) => { await fn(); ok++; console.log("ok -", nom); };
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
async function jusqua(cond, ms, quoi) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (cond()) return; await attendre(25); }
  throw new Error(`délai dépassé : ${quoi}`);
}

await cas("seul `reconfigurer: true` au premier niveau demande une reconfiguration", () => {
  assert.equal(demandeReconfiguration('{"result":"ok","dire":"Bien noté.","reconfigurer":true}'), true);
  assert.equal(demandeReconfiguration({ reconfigurer: true }), true);
  assert.equal(demandeReconfiguration('{"resultats":[]}'), false);
  assert.equal(demandeReconfiguration('{"reconfigurer":false}'), false);
  assert.equal(demandeReconfiguration('{"reconfigurer":"true"}'), false, "une chaîne n'est pas un booléen");
  assert.equal(demandeReconfiguration('{"texte":"il faut reconfigurer: true"}'), false, "un texte qui contient les mots");
  assert.equal(demandeReconfiguration("reconfigurer: true"), false, "sortie non JSON");
  assert.equal(demandeReconfiguration(null), false);
  assert.equal(demandeReconfiguration([{ reconfigurer: true }]), false);
});

// ---------- faux Dale Voz ----------
const OUTILS_ACCUEIL = [
  { type: "function", name: "search_knowledge_base", description: "Cherche", parameters: { type: "object", properties: {} } },
  { type: "function", name: "demarrer_parcours", description: "Démarre", parameters: { type: "object", properties: {} } },
];
const OUTILS_ETAPE = [
  { type: "function", name: "parcours_renseigner", description: "Renseigne", parameters: { type: "object", properties: {} } },
];
let etape = "accueil";          // ce que sert session-config
let configEnPanne = false;      // la relecture répond 500
let catalogueEtapeVide = false; // l'étape n'a aucun outil
const dv = []; // requêtes reçues, dans l'ordre
const plateforme = http.createServer((req, res) => {
  let corps = "";
  req.on("data", (c) => (corps += c));
  req.on("end", () => {
    const chemin = req.url.split("?")[0];
    const json = corps ? JSON.parse(corps) : null;
    dv.push({ chemin, url: req.url, corps: json, a: Date.now() });
    const rendre = (statut, o) => { res.writeHead(statut, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (chemin === "/api/voice/telephone") return rendre(200, { tenantId: "t-1", agentSlug: "palazzo", locale: "fr" });
    if (chemin === "/api/voice/session-config") {
      if (etape !== "accueil" && configEnPanne) return rendre(500, { error: "panne" });
      return rendre(200, etape === "accueil"
        ? { instructions: "CONSIGNE ACCUEIL", voice: "ara", reasoning: "none", tools: OUTILS_ACCUEIL }
        : { instructions: "CONSIGNE ETAPE 1 : demande le prénom.", voice: "autre-voix-ignoree", tools: catalogueEtapeVide ? [] : OUTILS_ETAPE });
    }
    if (chemin === "/api/voice/tool") {
      if (json.tool === "demarrer_parcours") {
        etape = "etape1";
        return rendre(200, { output: JSON.stringify({ result: "Parcours démarré.", dire: "Très bien, je vais prendre vos coordonnées.", reconfigurer: true }) });
      }
      return rendre(200, { output: JSON.stringify({ resultats: [] }) });
    }
    if (chemin === "/api/voice/persist") return rendre(200, { sessionId: "11111111-2222-3333-4444-555555555555" });
    if (chemin.startsWith("/api/voice/restaurant")) return rendre(404, {});
    return rendre(404, {});
  });
});
await new Promise((r) => plateforme.listen(0, "127.0.0.1", r));

// ---------- faux modèle temps réel (Grok ou Eleven, même protocole d'événements) ----------
// Scénario joué par réponse demandée : 1 = appel de demarrer_parcours, 2 = appel de search_knowledge_base, puis texte.
const modele = { evenements: [], ws: null };
let numeroReponse = 0;
const serveurModele = http.createServer((req, res) => {
  // jeton éphémère (xAI : /v1/realtime/client_secrets ; Eleven : /v1/convai/realtime/client_secrets)
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ value: "jeton-de-banc" }));
});
const wssModele = new WebSocketServer({ server: serveurModele });
wssModele.on("connection", (ws) => {
  modele.ws = ws;
  const envoyer = (o) => ws.send(JSON.stringify(o));
  ws.on("message", (raw) => {
    const e = JSON.parse(raw.toString());
    modele.evenements.push({ ...e, a: Date.now() });
    if (e.type === "session.update") envoyer({ type: "session.updated", session: e.session });
    if (e.type === "conversation.item.create") envoyer({ type: "conversation.item.created", item: { ...e.item, id: `item-${modele.evenements.length}` } });
    if (e.type === "response.create") {
      numeroReponse++;
      const id = `resp-${numeroReponse}`;
      envoyer({ type: "response.created", response: { id } });
      const outil = numeroReponse === 1 ? "demarrer_parcours" : numeroReponse === 2 ? "search_knowledge_base" : null;
      setTimeout(() => {
        if (outil) {
          envoyer({ type: "response.function_call_arguments.done", response_id: id, call_id: `call-${numeroReponse}`, name: outil, arguments: "{}" });
          envoyer({ type: "response.done", response: { id, status: "completed", output: [{ type: "function_call", call_id: `call-${numeroReponse}`, name: outil, arguments: "{}" }] } });
        } else {
          envoyer({ type: "response.done", response: { id, status: "completed", output: [] } });
        }
      }, 30);
    }
  });
});
await new Promise((r) => serveurModele.listen(0, "127.0.0.1", r));
const baseModele = `http://127.0.0.1:${serveurModele.address().port}`;

// ---------- le pont ----------
async function appel({ cerveau }) {
  modele.evenements = []; numeroReponse = 0; dv.length = 0; etape = "accueil";
  const port = 9300 + Math.floor(Math.random() * 500);
  const journal = [];
  const pont = spawn(process.execPath, [path.join(ICI, "..", "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      DALEVOZ_URL: `http://127.0.0.1:${plateforme.address().port}`,
      VOICE_BRIDGE_SECRET: "secret-de-banc",
      XAI_API_KEY: "cle-de-banc",
      XAI_REALTIME_BASE: baseModele,
      ...(cerveau === "eleven" ? { CERVEAU: "eleven", ELEVENLABS_API_KEY: "cle-de-banc", ELEVEN_REALTIME_URL: baseModele } : { CERVEAU: "grok" }),
      LECTURE_ELEVEN: "", N8N_WEBHOOK_URL: "", CALLS_FILE: "", AMBIANCE: "off", HEDGE_APRES_MS: "0", EOT_MODELE: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  pont.stdout.on("data", (d) => journal.push(...d.toString().split(/\r?\n/).filter(Boolean)));
  pont.stderr.on("data", (d) => journal.push(...d.toString().split(/\r?\n/).filter(Boolean).map((l) => "ERR " + l)));
  await jusqua(() => journal.some((l) => l.includes("[boot]")), 15000, "démarrage du pont");
  const twilio = new WebSocket(`ws://127.0.0.1:${port}/twilio`);
  await new Promise((r, k) => { twilio.on("open", r); twilio.on("error", k); });
  twilio.send(JSON.stringify({ event: "connected" }));
  twilio.send(JSON.stringify({ event: "start", start: { streamSid: "MZ-banc", callSid: "CA-banc", customParameters: { from: "+33600000000", to: "+33939205867" } } }));
  const fin = async () => {
    try { twilio.send(JSON.stringify({ event: "stop" })); twilio.close(); } catch {}
    await attendre(300);
    pont.kill();
  };
  return { journal, fin };
}

const sessions = () => modele.evenements.filter((e) => e.type === "session.update");
const sortiesOutils = () => modele.evenements.filter((e) => e.type === "conversation.item.create" && e.item?.type === "function_call_output");
const configs = () => dv.filter((r) => r.chemin === "/api/voice/session-config");

for (const cerveau of ["grok", "eleven"]) {
  const { journal, fin } = await appel({ cerveau });
  try {
    await cas(`${cerveau} : demarrer_parcours fait relire la config et rejouer session.update avant le résultat`, async () => {
      await jusqua(() => sortiesOutils().length >= 2, 15000, "deux résultats d'outils");
      assert.equal(configs().length, 2, "une lecture au décroché, une relecture après demarrer_parcours");
      assert.match(configs()[1].url, /agent=palazzo/);
      const [s1, s2] = sessions();
      assert.ok(s1 && s2, "deux session.update");
      assert.equal(sessions().length, 2, "aucun rejeu de plus");
      assert.match(s1.session.instructions, /CONSIGNE ACCUEIL/);
      assert.match(s2.session.instructions, /^CONSIGNE ETAPE 1/, "la consigne de l'étape");
      assert.ok(s2.session.instructions.includes("# Contexte de cet appel"), "le contexte de l'appel est gardé");
      const noms = (s) => (s.session.tools || []).map((o) => o.name);
      assert.deepEqual(noms(s1).filter((n) => n !== "end_call"), ["search_knowledge_base", "demarrer_parcours"]);
      assert.deepEqual(noms(s2), ["parcours_renseigner"], "le catalogue de l'étape remplace l'ancien");
      if (cerveau === "grok") {
        assert.equal(s2.session.voice, "ara", "la voix du décroché, pas celle d'une relecture");
        assert.deepEqual(s2.session.audio, s1.session.audio, "même format audio : l'appel ne coupe pas");
      }
      // ORDRE : relecture, session.update, function_call_output, puis relance du modèle.
      const i = (pred) => modele.evenements.findIndex(pred);
      const iRejeu = modele.evenements.indexOf(s2);
      const iSortie = i((e) => e.type === "conversation.item.create" && e.item?.call_id === "call-1");
      const iRelance = modele.evenements.findIndex((e, k) => k > iSortie && e.type === "response.create");
      assert.ok(configs()[1].a <= s2.a, "relecture avant le rejeu");
      assert.ok(iRejeu >= 0 && iRejeu < iSortie, "session.update AVANT le résultat de l'outil");
      assert.ok(iRelance > iSortie, "le modèle est relancé après le résultat");
      const sortie = JSON.parse(modele.evenements[iSortie].item.output);
      assert.equal(sortie.reconfigurer, true);
      assert.match(sortie.dire, /coordonnées/, "le texte à dire arrive tel quel au modèle");
    });
    await cas(`${cerveau} : un outil sans reconfigurer ne relit ni ne rejoue rien`, async () => {
      const sortie2 = sortiesOutils().find((e) => e.item.call_id === "call-2");
      assert.ok(sortie2, "résultat de search_knowledge_base rendu");
      assert.equal(configs().length, 2);
      assert.equal(sessions().length, 2);
      assert.ok(journal.some((l) => l.includes("[parcours] session rejouee : 1 outil(s) (parcours_renseigner")), "journal lisible");
    });
  } catch (e) {
    console.log(journal.slice(-60).join("\n"));
    throw e;
  } finally {
    await fin();
  }
}

{
  catalogueEtapeVide = true;
  const { journal, fin } = await appel({ cerveau: "grok" });
  try {
    await cas("grok : une étape sans outil envoie tools: [] et ne garde pas l'ancien catalogue", async () => {
      await jusqua(() => sortiesOutils().length >= 1 && sessions().length >= 2, 15000, "rejeu");
      assert.deepEqual(sessions()[1].session.tools, []);
    });
  } catch (e) { console.log(journal.slice(-60).join("\n")); throw e; } finally { catalogueEtapeVide = false; await fin(); }
}

{
  configEnPanne = true;
  const { journal, fin } = await appel({ cerveau: "grok" });
  try {
    await cas("grok : une relecture en panne rend une erreur au modèle, sans rejeu", async () => {
      await jusqua(() => sortiesOutils().length >= 1, 15000, "résultat d'outil");
      assert.equal(sessions().length, 1, "aucun session.update de plus");
      const sortie = JSON.parse(sortiesOutils()[0].item.output);
      assert.ok(sortie.error && !sortie.reconfigurer, "une erreur, pas l'étape");
      assert.ok(journal.some((l) => l.includes("reconfiguration NON appliquee")));
    });
  } catch (e) { console.log(journal.slice(-60).join("\n")); throw e; } finally { configEnPanne = false; await fin(); }
}

plateforme.close(); serveurModele.close(); wssModele.close();
console.log(`\n${ok} cas verts`);
process.exit(0);
