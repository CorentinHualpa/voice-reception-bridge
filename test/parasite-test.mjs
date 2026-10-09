// Banc de la retenue des reponses parasites (lib/parasite.js), sans reseau.
// node test/parasite-test.mjs
import assert from "assert";
import { PARASITE_RE, peutEtreParasite } from "../lib/parasite.js";

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; console.log("ok - " + msg); };

// Ce qui reste retenu (peut encore devenir un mot parasite)
ok(peutEtreParasite(""), "un debut vide reste retenu");
ok(peutEtreParasite("   "), "un debut fait d'espaces reste retenu (sinon un analysis au morceau suivant serait dit)");
ok(peutEtreParasite("an"), "« an » peut devenir analysis");
ok(peutEtreParasite("analysis"), "« analysis » complet reste retenu");
ok(peutEtreParasite("Final"), "« Final » reste retenu");
ok(peutEtreParasite("A"), "« A » reste retenu un morceau");
ok(peutEtreParasite("Comm"), "« Comm » peut devenir commentary");

// Ce qui part a la lecture des le morceau suivant
ok(!peutEtreParasite("Avec plaisir"), "« Avec plaisir » part");
ok(peutEtreParasite("Comment"), "« Comment » reste retenu un morceau (debut de commentary)");
ok(!peutEtreParasite("Comment puis-je"), "« Comment puis-je » part");
ok(!peutEtreParasite("Finalement"), "« Finalement » part");
ok(!peutEtreParasite("Bien sûr"), "« Bien sûr » part");
ok(!peutEtreParasite("Assistez"), "« Assistez » part");

// Ce qui n'est jamais dit
ok(PARASITE_RE.test("analysis"), "« analysis » seul est parasite");
ok(PARASITE_RE.test("Final!"), "« Final! » est parasite");
ok(!PARASITE_RE.test("analysis du besoin"), "une vraie phrase qui commence par le mot ne l'est pas");
ok(!PARASITE_RE.test("Finalement, je note."), "« Finalement » n'est pas parasite");

console.log(`\n${n} cas ok`);
