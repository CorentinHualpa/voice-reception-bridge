// Banc des fonctions d'Eleven Realtime (lib/eleven-realtime.js), sans reseau.
// node test/eleven-realtime-test.mjs
import assert from "assert";
import { creerPartNouvelle, sansBalisesEleven, urlRealtimeEleven } from "../lib/eleven-realtime.js";

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; console.log("ok - " + msg); };

// Transcription cumulative : les trois premiers tours du banc de Dany (20/10/2026), textes reels d'Eleven.
{
  const neuf = creerPartNouvelle();
  const t1 = "Oui, bonjour. J'ai une pompe de relevage dans mon sous-sol qui ne se déclenche plus. Il me faudrait un devis pour la remplacer.";
  const t2 = t1 + "Mohamed Lallouche.";
  const t3 = t2 + "Alors, c'est M-O-H-A-M-E-D point L-A deux L-O-U-C-H-E arobase gmail point com.";
  ok(neuf(t1) === t1, "premier tour : le texte entier");
  ok(neuf(t2) === "Mohamed Lallouche.", "deuxieme tour : la phrase recollee sans espace est coupee au bon mot");
  ok(neuf(t3) === "Alors, c'est M-O-H-A-M-E-D point L-A deux L-O-U-C-H-E arobase gmail point com.", "troisieme tour : l'email epele seul");
  ok(neuf(t3) === "", "meme texte renvoye : rien de neuf");
  ok(neuf(t3 + "Oui, c'est ça.") === "Oui, c'est ça.", "suite apres un doublon");
}
{
  const neuf = creerPartNouvelle();
  neuf("J'habite à Herblay.");
  ok(neuf("J'habite à Herblay.Oui, c'est bien ça.") === "Oui, c'est bien ça.", "casse et ponctuation sans effet sur la comparaison");
  ok(neuf("J'HABITE A HERBLAY. Oui c'est bien ça. Merci.") === "Merci.", "accents et casse retouches par la STT : on garde la suite");
}
{
  // Eleven retouche le debut (plus de 40 % des mots precedents changent) : on garde ce qui depasse l'ancien total.
  const neuf = creerPartNouvelle();
  neuf("un deux trois quatre cinq");
  ok(neuf("1 2 3 quatre cinq six sept") === "six sept", "debut retouche : seule la queue au-dela de l'ancien total reste");
}
{
  const neuf = creerPartNouvelle();
  ok(neuf("") === "", "texte vide : vide");
  ok(neuf("Allô ?") === "Allô ?", "premier mot");
}

// Balises de jeu glissees dans les reponses
ok(sansBalisesEleven("Je note. [friendly] Pourriez-vous me donner votre adresse ?") === "Je note. Pourriez-vous me donner votre adresse ?", "balise [friendly] retiree");
ok(sansBalisesEleven("Bonjour ! Je suis Dany. [happy] Je peux") === "Bonjour ! Je suis Dany. Je peux", "balise [happy] retiree");
ok(sansBalisesEleven("L, A, [deux] L") === "L, A, L", "crochets d'un seul mot retires aussi (aucune epellation ne les utilise)");
ok(sansBalisesEleven("Le tableau [1] suffit") === "Le tableau [1] suffit", "crochets avec un chiffre conserves");
ok(sansBalisesEleven("Je vais chiffrer votre commande. [chiffrer_commande]") === "Je vais chiffrer votre commande. ", "nom d'outil ecrit entre crochets retire");
ok(sansBalisesEleven("[heure_souhaitee]\nJe note deux Regina.").trim() === "Je note deux Regina.", "argument d'outil ecrit entre crochets retire");

ok(urlRealtimeEleven("eleven_realtime_v1_max") === "wss://api.elevenlabs.io/v1/convai/realtime?model=eleven_realtime_v1_max", "adresse du WebSocket");
console.log(`\n${n} verifications passees`);
