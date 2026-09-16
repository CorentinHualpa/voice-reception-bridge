// Banc du client Dale Voz du pont, sans réseau externe : un faux serveur joue la
// plateforme et vérifie ce que le pont envoie vraiment (secret, espace, corps).
// node test/dalevoz-test.mjs
import assert from "assert";
import http from "http";

process.env.VOICE_BRIDGE_SECRET = "secret-de-pont";
const recus = [];
const serveur = http.createServer((req, res) => {
  let corps = "";
  req.on("data", (c) => (corps += c));
  req.on("end", () => {
    recus.push({ url: req.url, methode: req.method, entetes: req.headers, corps: corps ? JSON.parse(corps) : null });
    const chemin = req.url.split("?")[0];
    if (chemin === "/api/voice/telephone") {
      // Un numéro que la plateforme ne connaît chez personne.
      if (req.url.includes("%2B33000000000")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Numéro non rattaché à un agent" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tenantId: "t-1", agentSlug: "palazzo", locale: "fr", authToken: "12345" }));
    } else if (chemin === "/api/voice/session-config") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ instructions: "Tu es l'assistante.", voice: "ara", tools: [{ type: "function", name: "search_knowledge_base" }] }));
    } else if (chemin === "/api/voice/tool") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: '{"resultats":[]}' }));
    } else if (chemin === "/api/voice/persist") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sessionId: "conv-1" }));
    } else {
      res.writeHead(404);
      res.end("{}");
    }
  });
});
await new Promise((r) => serveur.listen(0, "127.0.0.1", r));
process.env.DALEVOZ_URL = `http://127.0.0.1:${serveur.address().port}`;

const { resoudreNumero, chargerSession, executerOutil, enregistrerAppel, signatureTwilioValide, dalevozActif } =
  await import("../lib/dalevoz.js");

let ok = 0;
const cas = async (nom, fn) => { await fn(); ok++; console.log("ok -", nom); };

await cas("le pont est actif quand l'adresse et le secret sont posés", () => {
  assert.equal(dalevozActif, true);
});

await cas("le numéro appelé donne l'espace et l'agent, avec le secret en en-tête", async () => {
  const r = await resoudreNumero("+33939205867");
  assert.equal(r.canal.agentSlug, "palazzo");
  const appel = recus.at(-1);
  assert.match(appel.url, /numero=%2B33939205867/);
  assert.equal(appel.entetes["x-dalevoz-pont"], "secret-de-pont");
});

await cas("un numéro que la plateforme ne connaît chez personne est déclaré inconnu", async () => {
  const absent = await resoudreNumero("+33000000000");
  assert.equal(absent.inconnu, true);
  assert.equal(absent.canal, undefined);
});

await cas("la config de session part avec l'espace visé", async () => {
  const s = await chargerSession({ tenantId: "t-1", agentSlug: "palazzo", locale: "fr" });
  assert.equal(s.voice, "ara");
  assert.equal(recus.at(-1).entetes["x-dalevoz-tenant"], "t-1");
});

await cas("un outil de la plateforme reçoit l'agent et ses arguments", async () => {
  const r = await executerOutil({ tenantId: "t-1", agentSlug: "palazzo", outil: "search_knowledge_base", args: { query: "horaires" } });
  assert.equal(r.output, '{"resultats":[]}');
  assert.deepEqual(recus.at(-1).corps.args, { query: "horaires" });
});

await cas("l'appel écrit porte le canal téléphone et le CallSid", async () => {
  const r = await enregistrerAppel({
    tenantId: "t-1", agentSlug: "palazzo", appelId: "CA123", dureeMs: 61000, userId: "0612345678", locale: "fr",
    turns: [{ role: "user", text: "bonsoir" }, { role: "assistant", text: "Palazzo Pizza, bonsoir" }],
  });
  assert.equal(r.sessionId, "conv-1");
  const corps = recus.at(-1).corps;
  assert.equal(corps.canal, "telephone");
  assert.equal(corps.appelId, "CA123");
  assert.equal(corps.turns.length, 2);
});

await cas("signature Twilio : le vecteur de la doc passe, une signature modifiée échoue", () => {
  // Vecteur officiel, twilio.com/docs/usage/security (relu le 15/09/2026).
  const url = "https://example.com/myapp.php?foo=1&bar=2";
  const params = { Digits: "1234", To: "+18005551212", From: "+14158675310", Caller: "+14158675310", CallSid: "CA1234567890ABCDE" };
  const attendue = "L/OH5YylLD5NRKLltdqwSvS0BnU=";
  assert.equal(signatureTwilioValide({ authToken: "12345", url, params, signature: attendue }), true);
  assert.equal(signatureTwilioValide({ authToken: "12345", url, params, signature: "X" + attendue.slice(1) }), false);
  assert.equal(signatureTwilioValide({ authToken: "12345", url: url + "&tricheur=1", params, signature: attendue }), false);
  assert.equal(signatureTwilioValide({ authToken: "12345", url, params: { ...params, Digits: "9999" }, signature: attendue }), false);
  assert.equal(signatureTwilioValide({ authToken: "", url, params, signature: attendue }), false);
});

serveur.close();

await cas("plateforme muette : injoignable, et surtout pas « inconnu » (on ne refuse pas l'appel)", async () => {
  const r = await resoudreNumero("+33939205867");
  assert.equal(r.injoignable, true);
  assert.equal(r.inconnu, undefined);
});

console.log(`\n${ok} cas passes`);
