// Banc du transfert d'appel vers un humain : reglage, TwiML, message chuchote, issue, reprise. Sans reseau.
// node test/transfert-test.mjs
import assert from "assert";
import {
  creerRegistreTransferts,
  issueTransfert,
  numeroE164,
  numeroLisible,
  outilTransfert,
  phraseReprise,
  reglageTransfert,
  texteARappeler,
  twimlAnnonce,
  twimlApresTransfert,
  twimlReponseAnnonce,
  twimlTransfert,
} from "../lib/transfert.js";

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

cas("le reglage vient de l'agent Dale Voz, les variables du pont ne sont qu'un repli", () => {
  const dv = reglageTransfert({ transfert: { numero: "+33612345678", nom: "Lorenzo", sonnerie: 99, confirmation: true, siPasDeReponse: "agent" } }, { numero: "+33756964718" });
  assert.equal(dv.numero, "+33612345678");
  assert.equal(dv.sonnerie, 45, "sonnerie bornee");
  assert.equal(dv.source, "dalevoz");
  const repli = reglageTransfert(null, { numero: "0756964718", nom: "Lorenzo" });
  assert.equal(repli.numero, "+33756964718");
  assert.equal(repli.confirmation, false, "le repli garde le comportement du 16/09");
  assert.equal(repli.siPasDeReponse, "message");
  assert.equal(reglageTransfert({ transfert: null }, {}), null);
  assert.equal(reglageTransfert({ transfert: { numero: "06 12" } }, {}), null, "numero illisible = pas de transfert");
});

cas("le TwiML sonne chez l'humain avec le numero Twilio en appelant et rend la main au pont", () => {
  const t = twimlTransfert({ numero: "+33756964718", callerId: "+33939205867", actionUrl: "https://pont.exemple/apres-transfert?appel=CA1" });
  assert.ok(t.includes("<Number>+33756964718</Number>"));
  assert.ok(t.includes('callerId="+33939205867"'));
  assert.ok(t.includes('action="https://pont.exemple/apres-transfert?appel=CA1" method="POST"'));
  assert.ok(t.includes('timeout="25"'));
  assert.ok(t.includes('ringTone="fr"'));
  assert.ok(!t.includes("<Say"), "pas d'annonce : l'agent a deja prevenu le client");
});

cas("avec confirmation, la personne appelee entend d'abord le message chuchote", () => {
  const t = twimlTransfert({ numero: "+33756964718", callerId: "+33939205867", actionUrl: "https://p/a", annonceUrl: "https://p/transfert/annonce?appel=CA1", delaiSonnerie: 20 });
  assert.ok(t.includes('<Number url="https://p/transfert/annonce?appel=CA1" method="POST">+33756964718</Number>'));
  assert.ok(t.includes('timeout="20"'));
});

cas("le TwiML echappe ce qui vient de l'exterieur", () => {
  const t = twimlTransfert({ numero: "+33756964718", callerId: '+33"><Hangup/>', actionUrl: "https://x/a?b=1&c=2" });
  assert.ok(!t.includes('"><Hangup/>'));
  assert.ok(t.includes("b=1&amp;c=2"));
  const a = twimlAnnonce({ motif: '<Hangup/> "piege"', appelant: "+33612345678", reponseUrl: "https://p/r?appel=CA1" });
  assert.ok(!a.includes("<Hangup/> "), "le motif ne peut pas injecter de verbe");
});

cas("le message chuchote dit le motif et le numero, puis attend la touche 1, deux fois", () => {
  const a = twimlAnnonce({ motif: "une réclamation", appelant: "+33612345678", reponseUrl: "https://p/transfert/reponse?appel=CA1" });
  assert.ok(a.includes("Motif : une réclamation."));
  assert.ok(a.includes("06 12 34 56 78"));
  assert.equal((a.match(/<Gather /g) || []).length, 2);
  assert.ok(a.includes('action="https://p/transfert/reponse?appel=CA1"'));
  assert.ok(a.trim().endsWith("<Hangup/></Response>"), "sans touche, on raccroche SA jambe");
  assert.ok(twimlAnnonce({ reponseUrl: "x", langue: "es" }).includes('language="es-US"'));
});

cas("la touche 1 met en relation, toute autre raccroche", () => {
  assert.ok(!twimlReponseAnnonce({ digits: "1" }).includes("<Hangup/>"));
  assert.ok(twimlReponseAnnonce({ digits: "2" }).includes("<Hangup/>"));
  assert.ok(twimlReponseAnnonce({ digits: "" }).includes("<Hangup/>"));
});

cas("l'issue : avec confirmation, seul l'appui sur 1 vaut « pris »", () => {
  assert.equal(issueTransfert({ statut: "completed", duree: 40, confirmation: true, accepte: true }), "pris");
  assert.equal(issueTransfert({ statut: "completed", duree: 18, confirmation: true, accepte: false }), "refuse", "une messagerie qui decroche n'est pas un humain");
  assert.equal(issueTransfert({ statut: "no-answer", confirmation: true }), "sans_reponse");
  assert.equal(issueTransfert({ statut: "busy", confirmation: true }), "occupe");
  assert.equal(issueTransfert({ statut: "completed", duree: 12 }), "pris");
  assert.equal(issueTransfert({ statut: "completed", duree: 0 }), "sans_reponse");
  assert.equal(issueTransfert({ statut: "failed" }), "echec");
});

cas("conversation finie avec l'humain : on raccroche sans rien dire", () => {
  for (const statut of ["completed", "answered"]) {
    const t = twimlApresTransfert({ statut, nom: "Lorenzo" });
    assert.ok(t.includes("<Hangup/>"));
    assert.ok(!t.includes("<Say"), `rien a dire apres ${statut}`);
  }
  assert.ok(!twimlApresTransfert({ issue: "pris" }).includes("<Say"));
});

cas("personne n'a decroche, mode message : une phrase, puis on raccroche", () => {
  for (const statut of ["no-answer", "busy", "failed", "canceled", ""]) {
    const t = twimlApresTransfert({ statut, nom: "Lorenzo" });
    assert.ok(t.includes("Lorenzo n'a pas pu répondre"), statut);
    assert.ok(t.indexOf("<Say") < t.indexOf("<Hangup/>"));
  }
});

cas("personne n'a decroche, mode agent : l'appel revient au pont avec le parametre de reprise", () => {
  const t = twimlApresTransfert({ issue: "refuse", repriseStreamUrl: "wss://p/twilio", parametres: { from: "+33612345678", to: "+33939205867", callSid: "CA1" } });
  assert.ok(t.includes('<Connect><Stream url="wss://p/twilio">'));
  assert.ok(t.includes('<Parameter name="reprise" value="transfert"/>'));
  assert.ok(t.includes('<Parameter name="callSid" value="CA1"/>'));
  assert.ok(!t.includes("<Hangup/>"));
});

cas("la phrase de reprise nomme la personne et ne colle pas d'espace avant le point d'interrogation", () => {
  const p = phraseReprise({ nom: "Lorenzo" });
  assert.ok(p.startsWith("Lorenzo n'est pas disponible"));
  assert.ok(!/\s\?/.test(p));
  assert.ok(phraseReprise({ nom: "", langue: "en" }).startsWith("The advisor"));
});

cas("l'alerte a rappeler dit pourquoi, dans la langue de l'agent", () => {
  const fr = texteARappeler({ issue: "refuse", nom: "Lorenzo", motif: "devis", raccroche: true });
  assert.ok(fr.startsWith("Appel à rappeler : le transfert à Lorenzo n'a pas abouti (appel non pris)"));
  assert.ok(fr.includes("raccroché pendant la sonnerie"));
  assert.ok(fr.includes("Motif : devis."));
  const repris = texteARappeler({ issue: "sans_reponse", reprise: true, dit: "rappelez-moi demain" });
  assert.ok(repris.includes("un conseiller") && repris.includes("l'assistant a repris l'appel") && repris.includes("« rappelez-moi demain »"));
  assert.ok(texteARappeler({ issue: "occupe", langue: "es" }).startsWith("Llamada por devolver"));
});

cas("le numero se lit par paires a la francaise", () => {
  assert.equal(numeroLisible("+33612345678"), "06 12 34 56 78");
});

cas("le registre rend l'entree par CallSid et l'oublie quand on la retire", () => {
  const r = creerRegistreTransferts();
  const e = r.poser("CA1", { motif: "devis" });
  e.accepte = true;
  assert.equal(r.lire("CA1").accepte, true, "meme objet, modifiable par les routes");
  r.retirer("CA1");
  assert.equal(r.lire("CA1"), null);
});

cas("l'outil local nomme la personne et reste appelable sans argument", () => {
  const o = outilTransfert("Lorenzo");
  assert.equal(o.name, "transferer_appel");
  assert.ok(o.description.includes("passe-moi Lorenzo"));
  assert.deepEqual(o.parameters.required ?? [], []);
  assert.ok(outilTransfert("").description.includes("quelqu'un de l'équipe"));
});

console.log(`\n${ok} cas ok`);
process.exit(0);
