// Banc du transfert d'appel vers un humain : numero, TwiML, suite de la sonnerie. Sans reseau.
// node test/transfert-test.mjs
import assert from "assert";
import { numeroE164, outilTransfert, twimlApresTransfert, twimlTransfert } from "../lib/transfert.js";

let ok = 0;
const cas = (nom, fn) => { fn(); ok++; console.log("ok -", nom); };

cas("numero saisi a la francaise ou en E.164", () => {
  assert.equal(numeroE164("0756964718"), "+33756964718");
  assert.equal(numeroE164("07 56 96 47 18"), "+33756964718");
  assert.equal(numeroE164("+33756964718"), "+33756964718");
  assert.equal(numeroE164("0033756964718"), "+33756964718");
  assert.equal(numeroE164("075696471"), null);
  assert.equal(numeroE164(""), null);
  assert.equal(numeroE164(undefined), null);
});

cas("le TwiML sonne chez l'humain avec le numero Twilio en appelant et rend la main au pont", () => {
  const t = twimlTransfert({ numero: "+33756964718", callerId: "+33939205867", actionUrl: "https://pont.exemple/apres-transfert" });
  assert.ok(t.includes("<Number>+33756964718</Number>"));
  assert.ok(t.includes('callerId="+33939205867"'));
  assert.ok(t.includes('action="https://pont.exemple/apres-transfert" method="POST"'));
  assert.ok(t.includes('timeout="25"'));
  assert.ok(!t.includes("<Say"), "pas d'annonce : l'agent a deja prevenu le client");
});

cas("le TwiML echappe ce qui vient de l'exterieur", () => {
  const t = twimlTransfert({ numero: "+33756964718", callerId: '+33"><Hangup/>', actionUrl: "https://x/a?b=1&c=2" });
  assert.ok(!t.includes('"><Hangup/>'));
  assert.ok(t.includes("b=1&amp;c=2"));
});

cas("conversation finie avec l'humain : on raccroche sans rien dire", () => {
  for (const statut of ["completed", "answered"]) {
    const t = twimlApresTransfert({ statut, nom: "Lorenzo" });
    assert.ok(t.includes("<Hangup/>"));
    assert.ok(!t.includes("<Say"), `rien a dire apres ${statut}`);
  }
});

cas("personne n'a decroche : une phrase, puis on raccroche", () => {
  for (const statut of ["no-answer", "busy", "failed", "canceled", ""]) {
    const t = twimlApresTransfert({ statut, nom: "Lorenzo" });
    assert.ok(t.includes("Lorenzo n'a pas pu répondre"), statut);
    assert.ok(t.indexOf("<Say") < t.indexOf("<Hangup/>"));
  }
});

cas("l'outil nomme la personne et reste appelable sans argument", () => {
  const o = outilTransfert("Lorenzo");
  assert.equal(o.name, "transferer_appel");
  assert.ok(o.description.includes("passe-moi Lorenzo"));
  assert.deepEqual(o.parameters.required ?? [], []);
  assert.ok(outilTransfert("").description.includes("quelqu'un de l'équipe"));
});

console.log(`\n${ok} cas ok`);
