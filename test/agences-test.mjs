// Banc des lignes par agence (lib/agences.js), sans reseau.
// node test/agences-test.mjs
import assert from "assert";
import { normaliserNumero, lireAgences, agenceDeLigne, consigneAgence, champsAppelee } from "../lib/agences.js";

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; console.log("ok - " + msg); };
const CADRATIN = String.fromCharCode(0x2014);
const muet = { error: () => {} };
const sonde = () => { const lignes = []; return { error: (m) => lignes.push(m), lignes }; };

// normaliserNumero : toutes les ecritures d'un meme numero tombent sur la meme cle
for (const brut of ["+33939241266", "0939241266", "09 39 24 12 66", "33939241266", "0033939241266", "+33 (0)9 39 24 12 66", " +33 9 39 24 12 66 ", "+33.9.39.24.12.66"]) {
  ok(normaliserNumero(brut) === "+33939241266", `numero ecrit « ${brut} » : +33939241266`);
}
ok(normaliserNumero("") === "" && normaliserNumero(null) === "" && normaliserNumero(undefined) === "", "vide, null, undefined : chaine vide");
ok(normaliserNumero("+32470123456") === "+32470123456", "un numero etranger reste tel quel");

// lireAgences : variable absente ou abimee = aucun effet, jamais d'exception
ok(lireAgences("", muet).size === 0 && lireAgences(undefined, muet).size === 0, "variable absente : table vide");
const j1 = sonde();
ok(lireAgences("{pas du json", j1).size === 0 && /illisible/.test(j1.lignes[0]), "JSON illisible : table vide, signale");
const j2 = sonde();
ok(lireAgences('["+33939241266"]', j2).size === 0 && j2.lignes.length === 1, "un tableau au lieu d'un objet : table vide, signale");
const j3 = sonde();
const melange = lireAgences(JSON.stringify({
  "+33939241266": { nom: "Herblay" },
  "0123456789": "Sèvres",
  "pas un numero": { nom: "X" },
  "+33987654321": { nom: "   " },
  "+33911111111": { autre: "Etrechy" },
}), j3);
ok(melange.size === 2 && melange.has("+33939241266") && melange.has("+33123456789"), "deux entrees valides gardees (la forme texte seul accepte, 0123456789 devient +33123456789)");
ok(j3.lignes.length === 3, "trois entrees invalides signalees une par une, sans bloquer les autres");
ok(lireAgences(JSON.stringify({ "+33939241266": { nom: "x".repeat(200) } }), muet).get("+33939241266").nom.length === 60, "un nom demesure est borne a 60 caracteres");

// agenceDeLigne : la ligne appelee, quelle que soit l'ecriture du To
const table = lireAgences(JSON.stringify({ "+33939241266": { nom: "Herblay" }, "+33123456789": { nom: "Sèvres" }, "+33198765432": { nom: "Étrechy" } }), muet);
ok(agenceDeLigne(table, "+33123456789").nom === "Sèvres", "To de Twilio en E.164 : Sèvres");
ok(agenceDeLigne(table, "01 23 45 67 89").nom === "Sèvres", "meme ligne ecrite a la francaise : Sèvres");
ok(agenceDeLigne(table, "+33198765432").nom === "Étrechy", "Étrechy");
ok(agenceDeLigne(table, "+33600000000") === null, "un numero hors table : aucune agence (pas de repli sur Herblay)");
ok(agenceDeLigne(table, null) === null && agenceDeLigne(new Map(), "+33939241266") === null, "pas de numero ou table vide : aucune agence");

// consigneAgence : dit l'agence, ne porte aucun horaire, ne casse pas le prompt existant
const c = consigneAgence({ nom: "Étrechy" });
ok(/Agence appelée par ce client : Étrechy\./.test(c), "la consigne nomme l'agence appelee");
ok(/sans nommer d'agence/.test(c) && /tu ne cites les autres que si on te les demande/.test(c), "la consigne regle le cas « l'agence » sans nom et garde les autres agences en retrait");
ok(/tu restes Dany, de Motralec/.test(c), "la consigne ne change ni le nom ni l'accueil");
// Le prompt dit « Localisation 92 ou 91 : tu peux mentionner une agence proche, a Sevres ou a Etrechy » : sur la ligne de
// Sevres, il ne doit jamais proposer Sevres comme « proche » (relecture du 29/10/2026).
ok(/ne lui présente jamais comme « proche » ou « autre » l'agence qu'il vient d'appeler/.test(c) && /ne lui propose pas d'autre agence de toi-même/.test(c), "la consigne coupe la phrase du prompt « une agence proche, à Sèvres » pour l'agence appelée");
ok(!/\d\s?h|\bheures?\b/i.test(c), "aucun horaire dans la consigne (ils vivent dans le prompt)");
ok(!c.includes(CADRATIN), "pas de tiret cadratin");
ok(consigneAgence(null) === "" && consigneAgence({}) === "", "sans agence : chaine vide, rien n'est ajoute au contexte de l'appel");

// champsAppelee : ce qui part au recap n8n
ok(JSON.stringify(champsAppelee(table, "+33123456789")) === JSON.stringify({ appele: "+33123456789", agence: "Sèvres" }), "ligne connue : appele et agence");
ok(JSON.stringify(champsAppelee(table, "+33600000000")) === JSON.stringify({ appele: "+33600000000" }), "ligne inconnue : appele seul (n8n decide, il ne reçoit pas un faux nom)");
ok(JSON.stringify(champsAppelee(new Map(), "+33939241266")) === JSON.stringify({ appele: "+33939241266" }), "sans table : appele seul (n8n le lisait deja, repli Herblay), jamais agence");
ok(JSON.stringify(champsAppelee(table, null)) === "{}" && JSON.stringify(champsAppelee(table, "")) === "{}", "pas de numero appele : aucun champ ajoute");

console.log(`\n${n} verifications`);
