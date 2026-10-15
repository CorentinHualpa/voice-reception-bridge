// Banc de la garde « relecture unique de l'email » (lib/relecture.js), sans reseau.
// node test/relecture-test.mjs
import assert from "assert";
import { estRelecture, estRelectureEmail, partSure, parleDeLaVille } from "../lib/relecture.js";

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; console.log("ok - " + msg); };

// Les relectures reelles de l'appel du 15/10 et du prompt
const R1 = "Je vous épelle pour vérifier: N, D, I, A, S, S, E, M, A, Y, E, quarante-trois, arobase gmail point com. C'est bien ça?";
const R2 = "Je vous épelle pour vérifier: N, D, I, A, S, S, E, point, M, B, A, Y, E, quarante-trois, arobase gmail point com. C'est bien ça?";
ok(estRelectureEmail(R1), "premiere relecture de M. Mbaye reconnue");
ok(estRelectureEmail(R2), "deuxieme relecture (avec « point ») reconnue");
ok(estRelectureEmail("Je vous épelle : J, E, A, N, point, D, U, P, O, N, T, arobase gmail point com. C'est bien ça ?"), "exemple du prompt reconnu");
ok(estRelecture("É, L, O, D, I, E"), "lettre accentuee en tete reconnue");
ok(estRelectureEmail("Donc L, A, L, L, O, U, C, H, E arobase gmail point com ?"), "relecture sans annonce reconnue");
ok(estRelecture("Je répète : N comme Nicolas, D comme David, I comme Irène"), "« N comme Nicolas » reconnu");
ok(estRelecture("Je note N-D-I-A-S-S-E arobase gmail"), "lettres a tirets reconnues");
ok(estRelecture("Donc N D I A S S E arobase gmail"), "majuscules separees par des espaces reconnues");
ok(estRelecture("Je vous épelle pour vérifier : N,"), "annonce suivie d'une premiere lettre : relecture des cette lettre");
ok(!estRelecture("Je répète : u"), "en flux, « Je répète : u » n'est pas encore une lettre");
ok(!estRelectureEmail("Très bien, M, B, A, Y, E. Quelle est votre adresse mail, s'il vous plaît ?"), "un NOM epele n'arme pas la fenetre");

// Ce qui n'est jamais une relecture
const NORMALES = [
  "C'est corrigé, merci. Vous êtes dans quelle ville, s'il vous plaît?",
  "Pardon, pouvez-vous me redonner votre adresse mail, s'il vous plaît?",
  "Pourriez-vous me l'épeler lettre par lettre, s'il vous plaît ?",
  "Un conseiller vous rappellera au zéro sept, quarante-cinq, soixante-neuf, soixante-quinze, trente. C'est bien ça?",
  "DN trois cent soixante, c'est bien ça ?",
  "Il y a une agence à Sèvres, au cinquante-trois bis rue de la Garenne.",
  "Très bien, monsieur Mbaye. Quelle est votre adresse mail, s'il vous plaît?",
  "Et après l'arobase, s'il vous plaît ?",
  "Y a-t-il autre chose ? Je note tout pour le conseiller.",
  "Je répète : un conseiller vous rappellera demain matin.",
  "D'accord. Avez-vous une autre question, ou souhaitez-vous qu'un conseiller vous rappelle ?",
];
for (const t of NORMALES) ok(!estRelecture(t), `pas une relecture : « ${t.slice(0, 50)} »`);

// Lecture en flux, comme le pont : morceaux de 3 a 9 caracteres, la part sure part, une relecture coupe tout.
function lire(texte, graine = 7) {
  let lu = "", recu = "", envoye = 0, coupe = false, x = graine;
  for (let i = 0; i < texte.length && !coupe;) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const k = 3 + (x % 7);
    recu += texte.slice(i, i + k); i += k;
    if (estRelecture(recu)) { coupe = true; break; }
    const m = partSure(recu.slice(envoye));
    lu += recu.slice(envoye, envoye + m); envoye += m;
  }
  if (!coupe) lu += recu.slice(envoye); // fin de la reponse : le reste part
  return { lu, coupe };
}
const PIEGES = [
  ["R1", R1, ""],
  ["R2", R2, ""],
  ["prefixee", "D'accord, merci. " + R2, "D'accord, merci. "],
  ["sans annonce", "Très bien. N, D, I, A, S, S, E arobase gmail point com ?", "Très bien. "],
  ["introduction non reconnue", "D'accord, voici l'adresse que j'ai notée : N, D, I, A arobase gmail point com.", ""],
  ["comme", "Je répète : N comme Nicolas, D comme David, arobase gmail.", ""],
];
for (const g of [1, 7, 42, 99]) {
  for (const [nom, t, attendu] of PIEGES) {
    const r = lire(t, g);
    ok(r.coupe && r.lu === attendu, `${nom} (graine ${g}) : coupee, lu « ${r.lu} » (attendu « ${attendu} »)`);
  }
  for (const t of NORMALES) {
    const r = lire(t, g);
    ok(!r.coupe && r.lu === t, `normale lue en entier (graine ${g}) : « ${t.slice(0, 40)} »`);
  }
}
ok(partSure("Très bien, monsieur Mbaye. Je note tout ") === "Très bien, monsieur Mbaye. ".length, "une phrase finie part, la suivante attend sa fin");
ok(partSure("Merci. Je vous épelle pour vérifier : ") === "Merci. ".length, "tout part sauf l'annonce");
ok(partSure("C'est corrigé, merci") === 0, "une phrase pas finie attend");

// Fenetre
ok(parleDeLaVille("C'est noté, merci. Vous êtes dans quelle ville, s'il vous plaît ?"), "question de la ville reconnue");
ok(parleDeLaVille("Vous êtes dans quelle VILLE ?"), "ville en capitales reconnue");
ok(!parleDeLaVille("Très bien, je note votre adresse."), "pas de ville");
ok(!parleDeLaVille("Villeneuve-la-Garenne, c'est noté."), "« Villeneuve » n'est pas la question de la ville");

console.log(`\n${n} cas ok`);
