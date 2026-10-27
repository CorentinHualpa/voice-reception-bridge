// Banc de la note de tour d'Eleven (lib/note-de-tour.js), sans reseau.
// node test/note-de-tour-test.mjs
import assert from "assert";
import { noteDeTour } from "../lib/note-de-tour.js";

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; console.log("ok - " + msg); };
const CADRATIN = String.fromCharCode(0x2014);

// Le fil reel du 27/10 a 12:19 UTC, jusqu'a la premiere question sur la ville.
const fil = [
  { who: "Agent", msg: "Bonjour, bienvenue chez Motralec. Je suis Dany. Vous appelez pour quel sujet?" },
  { who: "Client", msg: "Une garantie." },
  { who: "Agent", msg: "Je note votre demande concernant une garantie. Pourriez-vous me donner votre prénom et votre nom, s'il vous plaît?" },
  { who: "Client", msg: "Timothée Henkel." },
  { who: "Agent", msg: "Très bien, monsieur Henkel. Quelle est votre adresse mail pour qu'on vous envoie le devis, s'il vous plaît?" },
  { who: "Client", msg: "sas.roussel.contact@gmail.com." },
  { who: "Agent", msg: "Je vous épelle pour vérifier: S, A, S, point, R, O, U, S, S, E, L, point, C, O, N, T, A, C, T, arobase gmail point com. C'est bien ça?" },
  { who: "Client", msg: "Ouais, parfait." },
];

ok(noteDeTour({ nouveau: "", dialog: fil }) === null, "rien de neuf : pas de note (la reponse part comme avant)");
ok(noteDeTour({ nouveau: "   ", dialog: fil }) === null, "que des espaces : pas de note");

const avantRelecture = noteDeTour({ nouveau: "sas.roussel.contact@gmail.com.", dialog: fil.slice(0, 5) });
ok(/« sas\.roussel\.contact@gmail\.com\. »/.test(avantRelecture), "la note cite la derniere phrase entre guillemets");
ok(!/Deja fait/.test(avantRelecture), "avant toute relecture : rien n'est annonce comme deja fait");

const apresConfirmation = noteDeTour({ nouveau: "Ouais, parfait.", dialog: fil });
ok(/« Ouais, parfait\. »/.test(apresConfirmation), "apres la relecture : la note cite « Ouais, parfait. »");
ok(/adresse mail a deja ete relue/.test(apresConfirmation), "la relecture de l'email est annoncee comme faite");
ok(!/question sur la ville/.test(apresConfirmation), "reponse a la relecture : rien sur la ville");

const filVille = [...fil, { who: "Agent", msg: "Merci. Vous êtes dans quelle ville, s'il vous plaît?" }];
const apresVille = noteDeTour({ nouveau: "Ce nom.", dialog: filVille });
ok(/« Ce nom\. »/.test(apresVille) && /repond a ta question sur la ville/.test(apresVille) && /telle quelle/.test(apresVille), "reponse breve a la ville : c'est la ville, prise telle quelle");
ok(/ne dis pas « c'est corrige »/.test(apresVille), "la note interdit « c'est corrige » sur la ville (le defaut du banc de refus)");
ok(/adresse mail a deja ete relue/.test(apresVille), "la relecture reste annoncee comme faite");
ok(!/question sur la ville/.test(noteDeTour({ nouveau: "Pardon ?", dialog: filVille })), "« Pardon ? » apres la question de la ville n'est pas pris pour la ville");
ok(!/question sur la ville/.test(noteDeTour({ nouveau: "Vous pouvez répéter", dialog: filVille })), "une demande de repeter n'est pas prise pour la ville");
const filNumero = [...filVille, { who: "Client", msg: "Ce nom." }, { who: "Agent", msg: "Un conseiller vous rappellera au zéro six, douze. C'est bien ça ?" }];
ok(!/question sur la ville/.test(noteDeTour({ nouveau: "Ouais.", dialog: filNumero })), "ville demandee AVANT la derniere question : la reponse suivante n'est pas prise pour la ville");

const nomEpele = [{ who: "Agent", msg: "Je vous épelle votre nom : H, E, N, K, E, L. C'est bien ça ?" }];
ok(!/adresse mail/.test(noteDeTour({ nouveau: "Oui.", dialog: nomEpele })), "un NOM epele ne compte pas comme relecture de l'email");

ok(/« Bonjour, j'ai une pompe »/.test(noteDeTour({ nouveau: "Bonjour,\n  j'ai   une pompe", dialog: [] })), "les retours a la ligne et espaces multiples sont aplatis");
ok([avantRelecture, apresConfirmation, apresVille].every((x) => !x.includes(CADRATIN)), "pas de tiret cadratin dans la note");
ok(apresVille.startsWith("(SYSTEME :") && apresVille.endsWith(")"), "meme forme que les autres messages systeme du pont");

console.log(`\n${n} verifications passees`);
