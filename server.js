// voice-reception-bridge
// Pont entre Twilio Media Streams (G.711 mu-law 8kHz) et xAI Grok Voice (PCM16).
// Un appel entrant Twilio -> <Connect><Stream> vers /twilio -> ce serveur ponte l'audio
// vers Grok Voice, capte le transcript, et POST un recap a n8n a la fin de l'appel.
//
// Variables d'environnement (voir .env.example) :
//   XAI_API_KEY        cle xAI (jamais en clair dans le code)
//   GROK_MODEL         defaut grok-voice-latest
//   GROK_VOICE         eve | ara | rex | sal | leo  (defaut eve)
//   GROK_RATE          rate PCM16 declare a Grok. 8000 = pas de resampling (a tester en 1er).
//   AGENT_LANG         fr | es | en  (defaut fr)
//   AGENT_NAME         nom de l'agent (defaut Dany)
//   BUSINESS_NAME      nom du commerce
//   BUSINESS_DESC      description courte (pour cadrer l'agent)
//   N8N_RECAP_URL      webhook n8n qui fait extraction + format + mail
//   PROMPT_FILE        fichier du prompt (si RECEPTION_PROMPT absent). {{CARTE}} y est remplace par la carte.
//   CLOSING_REGEX      phrase de cloture qui arme le raccrochage (defaut "remercie pour votre appel")
//   AGENT_TOOLS        "pizzeria" active les outils de prise de commande (voir lib/pizzeria.js)
//   MENU_FILE, DATA_FILE, CAPACITE_PAR_QUART, RESERVE_PAR_QUART, DELAI_MIN_MINUTES,
//   MAX_PIZZAS, SERVICES, TIME_ZONE   reglages du profil pizzeria
//   TRANSFERT_NUMERO   numero vers lequel l'agent bascule l'appel quand le client demande un humain (lib/transfert.js)
//   TRANSFERT_NOM      prenom annonce au client (« Je vous passe Lorenzo »)
//   PORT               injecte par Railway
//   Parades aux pics de Grok (une reponse sur cinq met 2,7 a 3,7 s avant son premier son) :
//   HEDGE_APRES_MS     seconde session Grok a qui on demande la meme reponse quand la premiere reste muette
//                      apres N ms (0 = coupee, valeur de travail 1000). Voir lib/doublure.js.
//   AMBIANCE_APRES_MS  fond de salle tres bas pendant les blancs, apres N ms (0 = coupe, valeur de travail 1800)
//   AMBIANCE_FICHIER   WAV PCM 16 bits mono a jouer en fond ; a defaut, bruit de confort synthetise
//   AMBIANCE_GAIN      volume du fond, 0,06 par defaut (assez bas pour ne pas passer le seuil de detection)
//   REDITE_ATTENTE_MS  battement laisse a la transcription avant de jeter une reponse qui n'a rien de neuf a
//                      dire (600 par defaut, 0 desactive la garde)

import http from "http";
import fs from "fs";
import { WebSocketServer, WebSocket } from "ws";
import { ulaw8kToPcm16, pcm16ToUlaw8k, ulawDecodeSample, ulawEncodeSample } from "./lib/audio.js";
import { chargerAmbiance } from "./lib/ambiance.js";
import { creerDoublure } from "./lib/doublure.js";
import { creerFinDeTour } from "./lib/fin-de-tour.mjs";
import { OUTILS_DE_COMMANDE, consigneClotureCommande, createPizzeria } from "./lib/pizzeria.js";
import {
  chargerSession,
  dalevozActif,
  ecrireCommandeRestaurant,
  ecrireRappelRestaurant,
  enregistrerAppel,
  executerOutil,
  lireRestaurant,
  pousserCarteRestaurant,
  resoudreNumero,
  signatureTwilioValide,
} from "./lib/dalevoz.js";
import { basculerAppel, numeroE164, outilTransfert, twimlApresTransfert, twimlTransfert } from "./lib/transfert.js";

const PORT = process.env.PORT || 8080;
const XAI_API_KEY = process.env.XAI_API_KEY;
const GROK_MODEL = process.env.GROK_MODEL || "grok-voice-latest";
const GROK_VOICE = process.env.GROK_VOICE || "eve";
const GROK_RATE = Number(process.env.GROK_RATE || 8000);
const GROK_SPEED = Number(process.env.GROK_SPEED || 1.0);          // vitesse de parole (0.7..1.5)
const GROK_VAD_THRESHOLD = Number(process.env.GROK_VAD_THRESHOLD || 0.6); // reactivite VAD (0.1..0.9 ; plus bas = plus sensible)
const GROK_REASONING = process.env.GROK_REASONING || "high";       // "high" = profond, "none" = rapide
const AGENT_LANG = process.env.AGENT_LANG || "fr";
const AGENT_NAME = process.env.AGENT_NAME || "Dany";
const BUSINESS_NAME = process.env.BUSINESS_NAME || "l'entreprise";
const BUSINESS_DESC = process.env.BUSINESS_DESC || "";
const N8N_RECAP_URL = process.env.N8N_RECAP_URL || "";
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // protege le tableau de bord /admin
const CLOSING_RE = new RegExp(process.env.CLOSING_REGEX || "remercie pour votre appel", "i");
const AGENT_SPEAKING_MAX_MS = Number(process.env.AGENT_SPEAKING_MAX_MS || 12000); // filet anti-surdite si le mark de fin de parole se perd ; un recapitulatif de commande depasse 12 s
const MAX_RELANCES_OUTILS = 4;
const BARGE_IN_DEFAUT = process.env.BARGE_IN === "1"; // repli quand l'agent ne vient pas de Dale Voz (voir le handler media)
// COUPER L'AGENT SUR UNE VRAIE PRISE DE PAROLE (16/09/2026). Deux signaux doivent s'accorder : Grok dit que
// le client parle (speech_started), et le pont mesure lui-meme au moins PAROLE_COUPURE_MS de voix au-dessus de
// SEUIL_SON_RMS sur les FENETRE_VOIX_MS dernieres millisecondes. Un « mmm » ou un « oui » n'y arrive pas, une
// phrase si. La voix se compte sur une fenetre glissante et non depuis l'evenement de Grok : son speech_started
// arrive jusqu'a 1,5 s apres le debut reel de la parole (appel de test enregistre), et un client qui parlait
// deux secondes par-dessus l'agent n'etait credite que de 320 ms, donc jamais entendu. Voir verifierCoupure.
// 400 ms (16/09/2026, appel de Coq) : a 700 ms, calibre sur le « Mmm » de synthese de l'appel de test (620 ms),
// ses vraies interruptions pendant que l'agent parlait mesuraient 680 et 620 ms de voix, et Chiara ne
// s'arretait jamais. Une interjection humaine (« attendez », « stop », « non non ») tient en 400 a 700 ms ;
// un souffle ou un clic reste en dessous.
const PAROLE_COUPURE_MS = Number(process.env.PAROLE_COUPURE_MS || 400);
// L'ACCUEIL SE COUPE APRES L'ANNONCE DE L'IA (16/09/2026, appel de Coq) : il ne se coupait jamais, et un client
// qui parlait dessus attendait ses 14 s. Ses ACCUEIL_PROTEGE_MS premieres secondes, celles qui disent que c'est
// une IA, restent protegees ; pendant ce temps un son doit faire PAROLE_ACCUEIL_MS pour devenir un tour.
const ACCUEIL_PROTEGE_MS = 5000;
const PAROLE_ACCUEIL_MS = 700;
const FENETRE_VOIX_MS = Number(process.env.FENETRE_VOIX_MS || 1500);
const SEUIL_SON_RMS = Number(process.env.SEUIL_SON_RMS || 600); // PCM16 ; le journal [son] de fin d'appel sert a le regler
// LE PONT DECIDE DE LA FIN DES TOURS (16/09/2026). Trois faits mesures sur l'API de Grok avant de le brancher :
// 1) son detecteur annonce la fin d'une phrase 1,4 a 1,6 s apres le dernier mot, quels que soient le seuil et
//    silence_duration_ms (voix de l'appel de test rejouee) : premier son a 2,2 s. En mode manuel
//    (audio.input.turn_detection: null ; `{ type: null }` a la racine NE le desactive PAS), le pont valide apres
//    FIN_DE_TOUR_MS de silence et le premier son arrive a 1,45 s ;
// 2) Grok ARRETE NET la reponse qu'il genere des qu'il entend le client, meme un « mmm », et la dit quand meme
//    « completed » : 1,2 s d'audio au lieu de 23,8 s sur le banc. C'etaient les fins de phrase coupees de Jacky.
//    Pendant qu'il genere, la voix du client est donc retenue par le pont et lui est envoyee juste apres ;
// 3) un son bref pendant que l'agent parle (« mmm », « oui ») n'est plus un tour : il est efface.
// TOURS=grok remet l'ancien fonctionnement (detecteur de Grok) sans toucher au code.
const TOURS_PAR_LE_PONT = (process.env.TOURS || "pont").toLowerCase() !== "grok";
// Repli seulement : l'attente de fin de phrase reglee dans l'onglet Voix de l'agent (silenceMs) prime. A 600 ms,
// « Euh des pizzas pour… deux personnes » faisait deux tours (appel de Coq, 16/09 19:17) : l'agent repondait
// pendant la pause, puis la suite de la phrase le coupait au premier mot.
const FIN_DE_TOUR_MS = Number(process.env.FIN_DE_TOUR_MS || 600);
const PREROLL_PAQUETS = 15;   // 300 ms de son envoyes avant le debut detecte d'une prise de parole
const TOUR_MAX_MS = 20000;    // filet : une ligne trop bruyante ne garde pas le tour ouvert indefiniment
const RELANCE_SUITE_MS = Number(process.env.RELANCE_SUITE_MS || 2500); // silence du client apres une reponse sans question
// REPONSE ANTICIPEE (17/09/2026, un testeur : « C'est un peu long à répondre », 1,8 s par tour). Un tour coutait
// l'attente de fin de phrase (900 ms pour Palazzo) PUIS ~0,7 s de Grok. Des ANTICIPATION_MS de silence, le pont
// valide deja la phrase et Grok genere ; le son n'est lache qu'a la fin du tour, donc la fin de phrase n'est pas
// plus courte. Si le client reprend avant (« Euh des pizzas pour… deux personnes »), la reponse est annulee
// (response.cancel) et effacee (conversation.item.delete), et la suite de la phrase part a Grok. Son message du
// client reste ouvert apres un commit tant que sa propre detection n'a pas clos la parole : la suite s'y ajoute,
// et le second commit valide le MEME message, entier. Effacer ce message puis renvoyer toute la phrase la
// doublait chez le modele (« Attendez, en fait, attendez, en fait, est-ce que… »). Bancs du 17/09 :
// test/bancs/banc-anticipation-protocole.mjs et banc-anticipation-ids.mjs (variante B).
// ANTICIPATION_MS=0 remet l'ancien fonctionnement sans toucher au code.
// 17/09/2026 (choix de Coq) : descendu de 400 a 250 ms. Le son n'est toujours lache qu'a la fin du tour, donc
// la fin de phrase n'est pas plus courte ; on gagne 150 ms sur TOUS les tours, pics compris. Le prix est un peu
// plus d'anticipations annulees sur les pauses d'hesitation, et une annulation se solde en 30 a 210 ms.
const ANTICIPATION_MS = Number(process.env.ANTICIPATION_MS ?? 250);
const ANNULATION_VOIX_MS = 150; // voix du client apres le lancement qui annule l'anticipation (le seuil d'un son ignore)
// REPONSE JAMAIS CREEE (17/09/2026, meme testeur, 6,4 s de blanc). Un tour valide sans mot reconnaissable
// (« euh », « mmm ») ne cree aucun message chez Grok, qui ignore alors response.create EN SILENCE : ni
// response.created ni erreur (banc : un « mmm » de 0,8 s, rien en 20 s). Le filet attendait 8 s, pendant lesquelles
// la vraie question du client restait retenue. En mode manuel, response.created arrive 90 a 180 ms apres le commit
// (51 tours mesures) : au-dela de REPONSE_IGNOREE_MS, la demande est perdue.
const REPONSE_IGNOREE_MS = Number(process.env.REPONSE_IGNOREE_MS || 1000);
// « MMM » D'ATTENTE (17/09/2026, choix de Coq). Une reponse sur cinq, Grok met 2,7 a 3,7 s a parler (cote xAI,
// hors de portee du pont) : le client entend un blanc. Quand rien n'est encore joue MMM_APRES_MS apres la fin de sa
// phrase et qu'une reponse est en route, l'agent fait « Mmm… » dans sa propre voix (Grok TTS, rendu en mu-law 8 kHz,
// produit une fois par voix et garde en memoire). Une fois par tour du client. MMM_APRES_MS=0 le coupe.
// Seuil a 2,4 s (repetition de demo du 17/09, choix de Coq) : a 1,8 s il partait sur 4 tours sur 6, dont 3 juste avant
// une reponse d'apres outil, qu'il retardait d'environ 0,5 s. Mesures avec l'anticipation : reponses rapides 1,1 a
// 1,6 s, reponses d'apres outil 1,9 a 2,35 s, pics de Grok au-dela de 2,7 s. Le seuil ne garde que les pics.
// ⛔ COUPE PAR DEFAUT (17/09/2026, Coq apres ecoute : « pas du tout naturel »). Le mecanisme reste en place pour un
// autre son ou une autre parade, mais aucun « Mmm » ne part tant que MMM_APRES_MS n'est pas pose sur le service.
const MMM_APRES_MS = Number(process.env.MMM_APRES_MS ?? 0);
// Appel de controle du 17/09 (15:34 UTC) : sur les tours avec outils plateforme, la relance est creee vers 1,7 s et son
// premier son arrive vers 2,4 s, pile sur le seuil : le « Mmm » partait 40 ms avant la reponse et la retardait de ~0,8 s.
// Un blocage de Grok, lui, se voit a une reponse CREEE depuis plus de 1,3 s sans aucun son (normal : 0,6 a 1,4 s).
// Donc pas de « Mmm » tant que la reponse en cours a ete creee il y a moins de MMM_CREEE_DEPUIS_MS : il attend, et ne
// part que si le son ne vient toujours pas.
const MMM_CREEE_DEPUIS_MS = Number(process.env.MMM_CREEE_DEPUIS_MS || 1300);
const MMM_TEXTE = process.env.MMM_TEXTE || "Mmm…";
// AMBIANCE DE SALLE (17/09/2026, apres le rejet du « Mmm »). Ce qui gene dans un pic de Grok n'est pas l'absence
// de mot, c'est le SILENCE NUMERIQUE TOTAL : le G.711 de Twilio transmet le silence tel quel, donc un blanc de
// 3,7 s s'entend comme une ligne coupee. Un fond de salle tres bas, joue seulement pendant ces blancs, enleve
// cette impression sans rien pretendre : personne ne l'entend comme une replique, donc rien ne peut sonner faux.
// Trois differences avec le « Mmm », qui sont ce qui le rend sans risque :
//   - il ne compte PAS comme audible (finLecture ne bouge pas) : la coupure de parole et la detection de tours
//     continuent normalement pendant qu'il joue, et il ne retarde jamais la vraie reponse ;
//   - il s'envoie en TEMPS REEL, un paquet de 20 ms a la fois, donc la file Twilio reste vide et il n'y a rien
//     a purger quand la reponse arrive ;
//   - il n'a pas de duree propre : il dure exactement le blanc, donc jamais deux blancs identiques.
// Coupe par defaut (AMBIANCE_APRES_MS=0). AMBIANCE_FICHIER = WAV PCM 16 bits mono (brouhaha de salle), sinon
// bruit de confort synthetise (RFC 3389). AMBIANCE_GAIN tres bas : assez pour tenir la ligne, trop bas pour
// passer le seuil de detection de voix, meme reinjecte par un haut-parleur.
const AMBIANCE_APRES_MS = Number(process.env.AMBIANCE_APRES_MS ?? 0);
const AMBIANCE_GAIN = Number(process.env.AMBIANCE_GAIN ?? 0.06);
const AMBIANCE_FICHIER = process.env.AMBIANCE_FICHIER || "";
const ambianceBoucle = AMBIANCE_APRES_MS > 0 ? chargerAmbiance({ source: AMBIANCE_FICHIER, gain: AMBIANCE_GAIN }) : null;
// DOUBLURE (17/09/2026, apres le rejet du « Mmm »). Le blocage de Grok est propre a UNE SESSION : au banc, deux
// sessions recevant la meme question au meme instant n'ont jamais ete lentes ensemble (24 tours, la premiere des
// deux : 0 pic au-dela de 2 s, max 1007 ms, contre 2418 ms pour la plus lente seule). Plutot que de masquer le
// blanc, on demande la meme reponse a une seconde session quand la premiere est muette, et on joue celle qui
// parle. Voir lib/doublure.js pour la coherence des deux historiques. HEDGE_APRES_MS=0 la coupe entierement.
// Le seuil se compte depuis la CREATION de la reponse, pas depuis la fin de parole du client : une relance
// d'apres outil est creee tard mais parle vite, elle ne doit pas declencher la doublure. Une reponse normale
// parle entre 0,6 et 1,4 s apres sa creation. Valeur de travail : 1000 ms. Un seuil plus bas ne degrade RIEN
// (la primaire garde son avance et gagne la course), il coute seulement des generations jetees ; un seuil plus
// haut retarde d'autant la parade. Sur un blocage a 3,7 s, la doublure parle vers 1,9 s au lieu de 3,7 s.
const HEDGE_APRES_MS = Number(process.env.HEDGE_APRES_MS ?? 0);
// FIN DE TOUR PAR MODELE (18/09/2026). Le pont conclut aujourd'hui qu'un client a fini quand il a compte
// FIN_DE_TOUR_MS de silence. C'est le plus gros poste de latence qui reste, et c'est ce qui coupe la parole a
// qui hesite : mesure sur 400 tours humains reels (corpus livekit/eot-bench-data, part francaise), le
// detecteur d'energie coupe 17,6 % des hesitations pour 685 ms d'attente moyenne. Smart Turn v3 regarde la
// forme d'onde, donc la prosodie : a attente egale, 10 % de coupures, soit 40 % d'interruptions en moins.
// Le modele REMPLACE le seuil de silence, il ne s'y empile pas : finDeTourMs ne sert plus que de FILET, pour
// les 30 a 43 % de fins de tour qu'il ne reconnait pas. EOT_MODELE=0 rend le pont d'avant, sans toucher au
// code. Reglage mesure au banc (10 % de coupures, 697 ms d'attente moyenne) : 0,98 / 500 ms / filet 900 ms.
// Le modele tourne dans un fil separe (voir lib/fin-de-tour.mjs) : son mel en JS pur bloquerait la pompe audio.
const EOT_MODELE = process.env.EOT_MODELE === "1";
const EOT_SEUIL = Number(process.env.EOT_SEUIL ?? 0.98);
const EOT_DELAI_MS = Number(process.env.EOT_DELAI_MS ?? 500);
const EOT_CADENCE_MS = Number(process.env.EOT_CADENCE_MS ?? 100);
// Battement laisse a la transcription du client avant de conclure qu'un tour ne portait aucun mot (voir
// `entreeNouvelle`). REDITE_ATTENTE_MS=0 desactive la garde anti-redite sans toucher au code.
const REDITE_ATTENTE_MS = Number(process.env.REDITE_ATTENTE_MS ?? 600);
// BANC SEULEMENT : retarde artificiellement le son de la primaire pour que la doublure gagne a coup sur. Sans
// lui, reproduire un blocage de Grok demande d'attendre un vrai pic (une reponse sur cinq). Ne jamais poser en
// production : la primaire est alors muette pendant ce delai meme quand elle repond vite.
const DOUBLURE_TEST_MS = Number(process.env.DOUBLURE_TEST_MS || 0);
// FINS DE PHRASE AVALEES (diagnostic du 17/09/2026, bancs test/bancs/banc-fin-coupee*.mjs). Grok lache le dernier
// signe d'une reponse, et avec lui la fin de la derniere syllabe, quand ce signe est un « ? » PRECEDE D'UNE ESPACE,
// comme le veut la typographie francaise : « Très bien. C'est pour quel prénom ? » s'entend « …pour quel prix ? »
// 3 fois sur 3, « …prénom? » 0 fois sur 3 ; « Vous la prenez ? » 2 sur 3, « prenez? » 0 sur 3. Ni le format audio
// (8, 16, 24 kHz, mu-law), ni la vitesse (1,0 a 1,2), ni la ligne n'y sont pour rien : aucun son n'arrive apres
// response.done, la transcription de Grok perd elle aussi son « ? ». Le modele imite la typographie de sa consigne :
// on retire ces espaces de TOUT ce qui lui est envoye, et on lui demande de coller le « ? » (banc en conversation :
// plus aucune espace ecrite, aucune fin avalee). TYPO_COLLEE=0 remet le texte tel quel.
const TYPO_COLLEE = process.env.TYPO_COLLEE !== "0";
const collerPonctuation = (s) => (TYPO_COLLEE && typeof s === "string" ? s.replace(/[   ]+([?!;:])/g, "$1") : s);
const CONSIGNE_PONCTUATION = "Écriture de tes réponses : le point d'interrogation et le point d'exclamation se collent au mot qui précède, sans espace avant (« C'est pour quel prénom? », « Parfait! »). Jamais « prénom ? » : au téléphone, cette espace fait avaler la fin de ta phrase.";
const sonsDAttente = new Map(); // "voix|vitesse|texte" -> Promise<Buffer mu-law | null>
function sonDAttente(voix, vitesse) {
  const cle = `${voix}|${vitesse}|${MMM_TEXTE}`;
  if (!sonsDAttente.has(cle)) {
    sonsDAttente.set(cle, (async () => {
      try {
        const r = await fetch("https://api.x.ai/v1/tts", {
          method: "POST",
          headers: { authorization: `Bearer ${XAI_API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({ text: MMM_TEXTE, voice_id: voix, language: AGENT_LANG, output_format: { codec: "mulaw", sample_rate: 8000 }, speed: vitesse }),
        });
        if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
        const son = rognerSon(Buffer.from(await r.arrayBuffer()));
        if (!son.length) throw new Error("son vide");
        console.log(`[attente] « ${MMM_TEXTE} » pret pour la voix ${voix} (${(son.length / 8000).toFixed(2)} s)`);
        return son;
      } catch (err) {
        console.error(`[attente] « ${MMM_TEXTE} » impossible pour la voix ${voix} : ${err.message}`);
        sonsDAttente.delete(cle); // l'appel suivant reessaie
        return null;
      }
    })());
  }
  return sonsDAttente.get(cle);
}
// Le son rendu par la synthese commence et finit par du silence : chaque milliseconde gardee retarde la vraie
// reponse qui le suit en file. On garde 20 ms avant la voix et 60 ms apres, en fondu pour eviter un clic.
function rognerSon(ulaw) {
  const n = Math.floor(ulaw.length / 160);
  let premier = -1, dernier = -1;
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (let i = 0; i < 160; i++) { const v = ulawDecodeSample(ulaw[k * 160 + i]); s += v * v; }
    if (Math.sqrt(s / 160) >= SEUIL_SON_RMS) { if (premier < 0) premier = k; dernier = k; }
  }
  if (premier < 0) return Buffer.alloc(0);
  const debut = Math.max(0, premier - 1) * 160, fin = Math.min(n, dernier + 4) * 160;
  const son = Buffer.from(ulaw.subarray(debut, fin));
  const fondu = Math.min(320, son.length >> 2);
  for (let i = 0; i < fondu; i++) {
    son[i] = ulawEncodeSample(Math.round(ulawDecodeSample(son[i]) * (i / fondu)));
    const j = son.length - 1 - i;
    son[j] = ulawEncodeSample(Math.round(ulawDecodeSample(son[j]) * (i / fondu)));
  }
  return son;
}
function rmsPcm16(buf) {
  const n = buf.length >> 1;
  if (!n) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) { const v = buf.readInt16LE(i * 2); s += v * v; }
  return Math.sqrt(s / n);
}
// Phrase de recapitulatif qui appelle un oui du client (sinon : une reponse qui cite des euros et pose une question).
const RECAP_RE = /c'est bien ça|c'est correct|est-ce (bien )?(correct|ça)|je récapitule|récapitul|ça vous va|is that (right|correct)|does that sound|es correcto|está bien así|è corretto|va bene così/i; // relances apres outil par tour client : au-dela, l'agent s'enchaine tout seul

if (!XAI_API_KEY) console.error("[boot] ATTENTION: XAI_API_KEY manquante");

// Transfert vers un humain : offert seulement si le numero est lisible. Un numero mal saisi
// se dit au demarrage, plutot que de promettre au client un transfert qui echouerait.
const TRANSFERT_NUMERO = numeroE164(process.env.TRANSFERT_NUMERO);
const TRANSFERT_NOM = (process.env.TRANSFERT_NOM || "").trim();
if (process.env.TRANSFERT_NUMERO && !TRANSFERT_NUMERO) console.error("[boot] TRANSFERT_NUMERO illisible, transfert desactive");
else if (TRANSFERT_NUMERO) console.log(`[boot] transfert d'appel vers ${TRANSFERT_NOM || "l'equipe"} actif`);

const pizzeria = process.env.AGENT_TOOLS === "pizzeria"
  ? createPizzeria({
      menuFile: process.env.MENU_FILE || "menus/palazzo.json",
      dataFile: process.env.DATA_FILE || "",
      capaciteParQuart: Number(process.env.CAPACITE_PAR_QUART || 15),
      reserveParQuart: Number(process.env.RESERVE_PAR_QUART || 0),
      delaiMinMinutes: Number(process.env.DELAI_MIN_MINUTES || 20),
      maxPizzas: Number(process.env.MAX_PIZZAS || 20),
      services: process.env.SERVICES || "11:30-14:30,18:30-22:30",
      timeZone: process.env.TIME_ZONE || "Europe/Paris",
      // Le tableau du restaurant dans Dale Voz (17/09/2026) : commandes et rappels y sont ecrits,
      // pause, delai, ruptures et quarts fermes y sont relus. Sans Dale Voz, tout reste local.
      distant: dalevozActif
        ? { lireEtat: lireRestaurant, ecrireCommande: ecrireCommandeRestaurant, ecrireRappel: ecrireRappelRestaurant, pousserCarte: pousserCarteRestaurant }
        : null,
    })
  : null;

// Historique des derniers appels (pour le tableau de bord /admin).
// Persiste sur un volume Railway si CALLS_FILE est defini (sinon en memoire, perdu au redeploiement).
const CALLS_FILE = process.env.CALLS_FILE || "";
function loadCalls() {
  if (!CALLS_FILE) return [];
  try { const a = JSON.parse(fs.readFileSync(CALLS_FILE, "utf8")); return Array.isArray(a) ? a : []; } catch { return []; }
}
function saveCalls() {
  if (!CALLS_FILE) return;
  try { fs.writeFileSync(CALLS_FILE, JSON.stringify(recentCalls)); } catch (e) { console.error("[calls] save KO", e.message); }
}
const recentCalls = loadCalls(); // { ts, from, sid, endReason, dialog }
function pushCall(c) { recentCalls.unshift(c); if (recentCalls.length > 100) recentCalls.length = 100; saveCalls(); }
function escHtml(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function normLine(s) { return String(s).toLowerCase().replace(/[^0-9a-zà-ÿ@ ]/gi, " ").replace(/\s+/g, " ").trim(); }
function frPhone(e164) { const m = String(e164 || "").replace(/\s/g, "").match(/^\+33(\d{9})$/); return m ? "0" + m[1] : (e164 || ""); }
// Numero FR -> lecture orale pre-calculee par paires (deterministe cote JS). On NE laisse PAS Grok
// calculer les groupes/mots : il se trompe sur les longues suites de chiffres et les nombres composes
// (quatre-vingt-seize, soixante-dix-huit...). On lui donne la phrase finie a repeter telle quelle.
function frUnit(n) { return ["zéro","un","deux","trois","quatre","cinq","six","sept","huit","neuf","dix","onze","douze","treize","quatorze","quinze","seize","dix-sept","dix-huit","dix-neuf"][n]; }
function frTwoDigits(n) {
  if (n < 20) return frUnit(n);
  if (n < 70) { const t = Math.floor(n / 10), u = n % 10, tw = { 2: "vingt", 3: "trente", 4: "quarante", 5: "cinquante", 6: "soixante" }[t]; return u === 0 ? tw : u === 1 ? tw + "-et-un" : tw + "-" + frUnit(u); }
  if (n < 80) return n === 71 ? "soixante-et-onze" : "soixante-" + frUnit(n - 60);
  if (n === 80) return "quatre-vingts";
  return "quatre-vingt-" + frUnit(n - 80); // 81..99 (dont 90..99 = quatre-vingt-dix..dix-neuf)
}
function frPhoneSpoken(fr) {
  const d = String(fr).replace(/\D/g, ""), out = [];
  for (let i = 0; i < d.length; i += 2) {
    const p = d.slice(i, i + 2);
    if (p.length === 1) out.push(frUnit(Number(p)));
    else if (p[0] === "0") out.push("zéro " + frUnit(Number(p[1])));
    else out.push(frTwoDigits(Number(p)));
  }
  return out.join(", ");
}

// Instruction de l'agent de reception (cf. agent-voiceflow-creator : voice_intake.md / voice_agent.md).
// Configurable par env (AGENT_NAME / BUSINESS_NAME / BUSINESS_DESC), surchargeable via RECEPTION_PROMPT.
const PROMPT_FROM_FILE = process.env.PROMPT_FILE
  ? fs.readFileSync(process.env.PROMPT_FILE, "utf8").replace("{{CARTE}}", pizzeria ? pizzeria.carteTexte() : "")
  : "";
const RECEPTION_PROMPT = process.env.RECEPTION_PROMPT || PROMPT_FROM_FILE || `Tu es ${AGENT_NAME}, l'assistant vocal telephonique de ${BUSINESS_NAME}${BUSINESS_DESC ? " (" + BUSINESS_DESC + ")" : ""}. Tu decroches quand le standard est ferme (hors horaires). Tu vouvoies, tu es chaleureux, calme et clair, une idee par phrase, une seule question a la fois.

Tu fais le tri :
- Question simple que tu connais (horaires, adresse, services) : tu reponds directement, tu ne demandes aucune coordonnee.
- Vrai besoin (devis, SAV, suivi, demande de rappel) : tu qualifies puis tu transmets pour rappel. Tu captes, dans l'ordre, une info a la fois : le besoin precis, puis le nom et le prenom, puis l'adresse email (demandee une seule fois, sans epeler), puis la ville. Le numero de telephone est deja connu (le numero appelant).

Tu confirmes a voix haute les marques, references et noms (pieges phonetiques). Tu ne donnes jamais de prix, de delai ferme ni de disponibilite ; tu dis qu'un conseiller confirmera. Tu n'inventes jamais une information.

A la fin, tu dis une phrase de cloture ("toute l'equipe vous remercie, un conseiller vous rappellera, bonne journee") et tu laisses la personne raccrocher. Tu n'envoies aucun mail toi-meme : le recap part automatiquement.

Reponds toujours en ${AGENT_LANG === "es" ? "espagnol" : AGENT_LANG === "en" ? "anglais" : "francais"}.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// File de reessai en memoire : si n8n est injoignable au raccrochage, on garde
// le recap et on retente, pour qu'un hoquet reseau ne perde jamais un appel.
const pendingRecaps = [];

async function postRecap(payload, attempts) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(N8N_RECAP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (r.ok) return true;
      console.error(`[recap] n8n status ${r.status} (essai ${i + 1}/${attempts}) sid=${payload.call_sid}`);
    } catch (e) {
      console.error(`[recap] echec POST essai ${i + 1}/${attempts} sid=${payload.call_sid}: ${e.message}`);
    }
    if (i < attempts - 1) await sleep(1000 * Math.pow(2, i)); // 1s, 2s, 4s...
  }
  return false;
}

// Reessai de fond toutes les 60s pour les recaps qui n'ont pas pu partir au raccrochage.
setInterval(async () => {
  if (!pendingRecaps.length || !N8N_RECAP_URL) return;
  const batch = pendingRecaps.splice(0, pendingRecaps.length);
  for (const p of batch) {
    const ok = await postRecap(p, 2);
    if (ok) console.log(`[recap] renvoye depuis la file sid=${p.call_sid}`);
    else pendingRecaps.push(p);
  }
}, 60000);

function renderCommandes() {
  if (!pizzeria) return "";
  const euros = (x) => (x == null ? "?" : x.toFixed(2).replace(".", ",") + " €");
  const cmds = pizzeria.commandes().map((c) => `<div style="border:1px solid #e5e7eb;border-radius:10px;padding:12px 16px;margin:10px 0;background:#fff">
      <div style="font-weight:600">N° ${escHtml(c.numero)} &middot; ${escHtml(c.prenom)} &middot; retrait ${escHtml(c.jour)} à ${escHtml(c.heure_retrait)} &middot; ${euros(c.total_eur)}</div>
      <div style="font-size:12px;color:#4b5563;margin:2px 0 6px">prise le ${escHtml(c.ts)} &middot; ${escHtml(c.telephone || "numéro inconnu")}</div>
      ${c.lignes.map((l) => `<div style="font-size:14px">${l.quantite} × ${escHtml(l.produit)}${l.supplements.length ? " + " + escHtml(l.supplements.join(", ")) : ""}${l.retraits.length ? " sans " + escHtml(l.retraits.join(", ")) : ""}${l.remarque ? " (" + escHtml(l.remarque) + ")" : ""} &middot; ${euros(l.sous_total_eur)}</div>`).join("")}
      ${c.remarque ? `<div style="font-size:13px;margin-top:4px">Remarque : ${escHtml(c.remarque)}</div>` : ""}
    </div>`).join("") || '<p style="color:#4b5563">Aucune commande.</p>';
  const msgs = pizzeria.messages().map((m) => `<div style="border:1px solid #fde68a;border-radius:10px;padding:10px 16px;margin:8px 0;background:#fffbeb">
      <div style="font-weight:600">${escHtml(m.motif)} &middot; ${escHtml(m.prenom || "sans prénom")} &middot; ${escHtml(m.telephone || "numéro inconnu")}</div>
      <div style="font-size:12px;color:#4b5563">${escHtml(m.ts)}</div>
      ${m.details ? `<div style="font-size:14px;margin-top:4px">${escHtml(m.details)}</div>` : ""}
    </div>`).join("") || '<p style="color:#4b5563">Aucun message.</p>';
  return `<h2 style="font-size:16px;margin:0 0 4px">Commandes</h2>${cmds}
    <h2 style="font-size:16px;margin:18px 0 4px">Messages à rappeler</h2>${msgs}<div style="height:18px"></div>`;
}

function renderDashboard() {
  const cfg = `voix ${GROK_VOICE} · vitesse ${GROK_SPEED} · VAD ${GROK_VAD_THRESHOLD} · raisonnement ${GROK_REASONING} · rate ${GROK_RATE} · langue ${AGENT_LANG}`;
  const calls = recentCalls.map((c) => {
    const lines = escHtml(c.dialog).split("\n").map((l) => {
      const m = l.match(/^(Client|Agent)\s*:\s*([\s\S]*)$/);
      if (!m) return `<div>${l}</div>`;
      const who = m[1] === "Client" ? "Client" : AGENT_NAME;
      const color = m[1] === "Client" ? "#1d4ed8" : "#0a7d4b";
      return `<div style="margin:2px 0"><span style="color:${color};font-weight:600">${who}</span> : ${m[2]}</div>`;
    }).join("");
    return `<div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin:12px 0;background:#fff">
      <div style="font-size:12px;color:#6b7280;margin-bottom:8px">${escHtml(c.ts)} &middot; ${escHtml(c.from || "inconnu")} &middot; fin : ${escHtml(c.endReason)}</div>
      <div style="font-size:14px;line-height:1.5;color:#111827">${lines}</div>
    </div>`;
  }).join("") || '<p style="color:#6b7280">Aucun appel enregistre pour le moment.</p>';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(AGENT_NAME)} - ${escHtml(BUSINESS_NAME)} - suivi</title></head>
  <body style="font-family:Segoe UI,Roboto,Arial,sans-serif;background:#f3f4f6;margin:0;padding:24px;color:#111827">
  <div style="max-width:780px;margin:0 auto">
    <h1 style="font-size:22px;margin:0 0 4px">${escHtml(AGENT_NAME)} &middot; ${escHtml(BUSINESS_NAME)}</h1>
    <div style="color:#6b7280;font-size:13px;margin-bottom:18px">${escHtml(cfg)} &middot; ${recentCalls.length} appel(s) en memoire</div>
    <details style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:18px">
      <summary style="cursor:pointer;font-weight:600">Prompt actuel de l'agent</summary>
      <pre style="white-space:pre-wrap;font-size:12px;color:#374151;margin-top:10px">${escHtml(RECEPTION_PROMPT)}</pre>
    </details>
    ${renderCommandes()}
    <h2 style="font-size:16px;margin:0 0 4px">Derniers appels (le plus recent en haut)</h2>
    ${calls}
  </div></body></html>`;
}

const server = http.createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];
  if (path === "/admin") {
    const key = new URL(req.url, "http://x").searchParams.get("key") || "";
    if (!ADMIN_KEY || key !== ADMIN_KEY) { res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" }); res.end("non autorise"); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderDashboard());
    return;
  }
  if (path === "/twiml") {
    // Webhook Voice de Twilio : renvoie le TwiML qui connecte l'appel au pont WS.
    // On injecte le numero appelant (From), le numero appele (To) et le CallSid :
    // le pont resout ensuite l'agent Dale Voz a partir du numero appele.
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const post = Object.fromEntries(new URLSearchParams(body));
      const query = new URL(req.url, "http://x").searchParams;
      const propre = (v) => String(v || "").replace(/[<>&"']/g, "");
      const from = propre(post.From || query.get("From"));
      const to = propre(post.To || query.get("To"));
      const callSid = propre(post.CallSid || query.get("CallSid"));
      const host = req.headers.host;

      // Numero rattache a un agent Dale Voz : on verifie que l'appel vient bien
      // de Twilio avant de decrocher. L'adresse du webhook est publique, sans
      // cette verification n'importe qui ferait parler l'agent d'un client.
      let tenantId = "";
      if (dalevozActif && to) {
        const r = await resoudreNumero(to);
        if (r.inconnu) {
          console.error(`[twiml] numero inconnu ${to}`);
          res.writeHead(404, { "Content-Type": "text/xml" });
          res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Say language="fr-FR">Ce numéro n'est pas configuré.</Say><Hangup/></Response>`);
          return;
        }
        // Plateforme injoignable : on decroche quand meme, sur la config locale.
        // Une panne de la console ne doit pas faire taire les numeros branches.
        if (r.canal) {
          const urlComplete = `https://${host}${req.url}`;
          const signature = req.headers["x-twilio-signature"] || "";
          if (!signatureTwilioValide({ authToken: r.canal.authToken, url: urlComplete, params: post, signature })) {
            console.error(`[twiml] signature Twilio refusee sid=${callSid} to=${to}`);
            res.writeHead(403, { "Content-Type": "text/plain" });
            res.end("signature invalide");
            return;
          }
          tenantId = r.canal.tenantId;
        } else {
          console.error(`[twiml] plateforme injoignable, repli sur la config locale to=${to}`);
        }
      }

      const params = [
        `<Parameter name="from" value="${from}"/>`,
        to ? `<Parameter name="to" value="${to}"/>` : "",
        callSid ? `<Parameter name="callSid" value="${callSid}"/>` : "",
      ].join("");
      const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://${host}/twilio">${params}</Stream></Connect></Response>`;
      if (tenantId) console.log(`[twiml] appel accepte to=${to} sid=${callSid}`);
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(xml);
    });
    return;
  }
  if (path === "/apres-transfert") {
    // Fin de la sonnerie ou de la conversation avec l'humain (attribut action du <Dial>).
    // Meme verification de signature que /twiml : sans elle, n'importe qui pourrait
    // deposer de faux messages « a rappeler » dans le tableau de bord.
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const post = Object.fromEntries(new URLSearchParams(body));
      const statut = String(post.DialCallStatus || "");
      let signatureOk = !dalevozActif;
      if (dalevozActif && post.To) {
        const r = await resoudreNumero(post.To);
        signatureOk = Boolean(r.canal) && signatureTwilioValide({
          authToken: r.canal.authToken,
          url: `https://${req.headers.host}${req.url}`,
          params: post,
          signature: req.headers["x-twilio-signature"] || "",
        });
      }
      if (!signatureOk) {
        console.error(`[transfert] fin refusee (signature) sid=${post.CallSid}`);
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("signature invalide");
        return;
      }
      console.log(`[transfert] fin statut=${statut} duree=${post.DialCallDuration || 0}s sid=${post.CallSid}`);
      if (statut !== "completed" && statut !== "answered" && pizzeria) {
        // Personne n'a decroche : l'equipe doit rappeler, comme pour un message transmis.
        pizzeria.runAsync("transmettre_message", {
          motif: `Voulait parler à ${TRANSFERT_NOM || "un humain"}, transfert sans réponse (${statut || "inconnu"})`,
        }, { callSid: post.CallSid || null, from: frPhone(post.From) });
      }
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(twimlApresTransfert({ statut, nom: TRANSFERT_NOM }));
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("voice-reception-bridge ok");
});
const wss = new WebSocketServer({ server, path: "/twilio" });

wss.on("connection", (twilio, requete) => {
  const hotePont = requete?.headers?.host || ""; // pour l'adresse de fin de transfert
  let streamSid = null;
  let callSid = null;
  let fromNumber = null;
  let toNumber = null;    // numero APPELE : c'est lui qui designe l'agent Dale Voz
  let canalDV = null;     // { tenantId, agentSlug, locale... } quand le numero est rattache
  let sessionDV = null;   // instructions, voix et outils de la version publiee de l'agent
  // LA PRISE DE COMMANDE PAR DALE VOZ (17/09/2026) : quand la console l'a confiee a la plateforme, la
  // session publiee porte les outils de commande ET le contexte du restaurant (heure, pause, ruptures,
  // carte). Le profil local `pizzeria` s'efface alors : ni ses outils, ni sa carte, ni son contexte.
  const commandesParDaleVoz = () => Boolean(sessionDV?.tools?.some((t) => t.name === "enregistrer_commande"));
  let commandeEnregistreeDV = false; // pour la garde de cloture, une commande par appel
  let sessionIdDV = null; // fil Dale Voz, cree a l'ecriture de l'appel
  let bargeIn = BARGE_IN_DEFAUT; // regle par l'agent Dale Voz (settings.telephone.couperLaParole) des que la session est chargee
  const debutAppelMs = Date.now();
  let grok = null;
  let grokReady = false;
  const dialog = []; // { who: 'Client' | 'Agent', msg }
  let userBuf = "";
  let agentBuf = "";
  let finalized = false;
  let endRequested = false;
  let endReason = "raccroche par le client";
  let closingSaid = false;
  let checkedIn = false;
  let closeTriggered = false;
  let greetRetry = 0;
  let lastCallerMs = Date.now();
  let pendingCalls = [];   // appels d'outils de la reponse en cours, traites en response.done
  let relancesOutils = 0;  // relances apres outil depuis le dernier tour client
  let finDeTourMs = FIN_DE_TOUR_MS;                 // remplace par le reglage de l'agent Dale Voz a l'ouverture
  let relanceOutilDemandee = false, reponseApresOutil = false; // la relance de suite ne vaut qu'apres un outil
  let clotureVerifiee = false; // garde « commande annoncee sans enregistrement » : une seule consigne par appel
  let messageTransmisSansReponse = false; // garde « pas de raccrochage juste apres transmettre_message »
  // CE QUE L'AGENT A DIT (17/09/2026, demande de la plateforme) : Dale Voz verifie que le recapitulatif DIT couvre la
  // commande avant de l'enregistrer. repliqueEnCours = ce que l'agent a dit en entier depuis la derniere parole du
  // client ; repliqueAvantClient = ce qu'il avait dit juste avant elle, envoye en appel.replique aux outils de commande.
  let repliqueEnCours = "", repliqueAvantClient = "";
  let recapTs = 0, clientApresRecap = false; // garde « pas d'enregistrement sans recapitulatif suivi d'une reponse du client »
  let audioReponseOctets = 0, debutReponseMs = 0; // audio mu-law envoye a Twilio pour la reponse en cours (8000 octets = 1 s)
  let premierSon = false, finParoleClientMs = 0; // mesure de la latence percue par l'appelant
  let reponseCoupee = 0;                        // reponse dont l'audio restant est jete
  let parleSelonGrok = false;                   // entre speech_started et speech_stopped
  let entenduSurAgent = false, voixMaxTour = 0, coupeCeTour = false; // pour le journal « son bref ignore »
  let accueilProtegeJusqua = Infinity;          // rien ne se coupe avant le premier son, puis l'annonce de l'IA
  const voixFenetre = new Array(Math.max(1, Math.round(FENETRE_VOIX_MS / 20))).fill(0); // ms de voix par paquet de 20 ms
  let voixFenetreIdx = 0, voixRecenteMs = 0;
  const sonHisto = [0, 0, 0, 0, 0, 0];         // niveaux de la voix du client par paquet : <150 <300 <600 <1200 <2400 >=2400
  const sonHistoAgent = [0, 0, 0, 0, 0, 0];    // les memes, seulement pendant que l'agent est audible : l'echo d'une ligne se voit ici
  // HORODATAGE RELATIF (16/09/2026) : Railway regroupe les lignes de journal et leur donne parfois la meme
  // heure a plusieurs secondes d'ecart, ce qui rendait illisible l'ordre reel des evenements d'un tour.
  const t = () => `t+${((Date.now() - debutAppelMs) / 1000).toFixed(2)}`;
  let audioEnvoyeMs = 0;                        // audio du client envoye a Grok : a comparer au audio_start_ms de ses evenements
  const typesVus = new Set();
  // Tours decides par le pont (voir TOURS_PAR_LE_PONT).
  let generation = false, generationDemandeeA = 0; // Grok genere une reponse : la voix du client est retenue
  let reponseActive = false;                    // entre response.created et response.done
  let retenue = [];                             // paquets PCM retenus pendant la generation
  let tour = null;                              // prise de parole en cours : { debut, voixMs, derniereVoix, coupe }
  // Fin de tour par modele (voir EOT_MODELE) : un fil separe qui ecoute tout l'appel et repond « il a fini »
  // bien avant le filet. `eotFini` compte les tours qu'il a conclus, pour le bilan de fin d'appel.
  const eot = EOT_MODELE && TOURS_PAR_LE_PONT
    ? creerFinDeTour({ cadenceMs: EOT_CADENCE_MS, surErreur: (m) => console.log(`[eot] fil en erreur : ${m} sid=${callSid}`) })
    : null;
  let eotFini = 0;
  const preroll = [];
  let tourEnAttente = false;                    // prise de parole finie pendant une generation ou des outils
  let outilsEnCours = false;
  let attenteCreation = false, creationDemandeeA = 0; // response.create envoye apres un commit, response.created pas encore recu
  // « Mmm » d'attente (voir MMM_APRES_MS) : fin de parole du client dont la reponse n'a encore rien fait entendre,
  // fin de lecture du « Mmm » (pas de coupure de parole dessus), son pret pour la voix de cet appel.
  let attenteDepuis = 0, mmmJusqua = 0, mmmAvantReponse = false;
  // Ambiance de salle (voir AMBIANCE_APRES_MS) : position dans la boucle, debut du blanc en cours, total joue.
  let ambiancePos = 0, ambianceDepuis = 0, ambianceMs = 0;
  // Doublure (voir HEDGE_APRES_MS) : seconde session Grok, curseur de synchronisation sur `dialog`, tour en
  // cours de doublage, et compteurs pour le compte rendu de fin d'appel.
  let doublure = null, doublureSyncIdx = 0, doublureTour = 0, doublureGagnees = 0, doublureDemandees = 0;
  let doublureGagnante = false; // la reponse en cours est jouee par la doublure, pas par la primaire
  let resteAudioDoublure = Buffer.alloc(0); // octet impair en attente, comme pour la primaire
  let primaireJetee = 0;                    // n° de la reponse de la primaire dont le son ne doit plus partir
  // GROK REDIT SA DERNIERE REPONSE quand on lui demande une reponse SANS nouvelle entree (banc
  // `banc-parades-pics.mjs avide` : premiere demande a vide ignoree en silence, seconde repetee mot pour mot).
  // Le pont valide un tour des que le client a fait assez de bruit, or un « mmm » ou un souffle ne cree AUCUN
  // message chez Grok (cf. REPONSE_IGNOREE_MS) : la reponse qui suit est alors la precedente, redite.
  // `entreeNouvelle` dit qu'il y a bien de quoi repondre : une transcription du client non vide, un resultat
  // d'outil, ou une consigne poussee par le pont. Faux au moment ou un tour est valide, vrai des que la
  // transcription arrive (~400 ms apres le commit, soit avant le premier son, qui vient a 0,6-1,4 s).
  let entreeNouvelle = true;                // l'accueil n'a pas d'entree et ne doit pas etre bloque
  // ⚠ Un « mmm » dit juste apres une phrase s'AJOUTE au meme message chez Grok (meme `item_id`, cf. le piege du
  // commit qui ne ferme pas le message) : son texte a l'air neuf alors que le message a deja servi. La garde
  // suit donc l'IDENTIFIANT du message du client, pas son contenu.
  let dernierItemClient = "", itemClientConsomme = "";
  let retenueRedite = [];                   // son garde le temps de savoir si cette reponse est une redite
  let retenueDepuis = 0;                    // debut de cette retenue
  let rediteTranchee = false;               // une fois par reponse
  let sonMmm = null;
  // Reponse anticipee (voir ANTICIPATION_MS) : { tour, etat "demandee" | "creee" | "finie", annulee, annuleeA, voixDepuis,
  // audio (mu-law retenu jusqu'a la fin du tour), pretA, fin (response.done differe), items (de la reponse), closingAvant, depuis }
  let anticipation = null;
  const itemsAjoutes = new Set(); // elements reellement crees chez Grok : on n'efface que ceux-la
  let suppressionsEnCours = 0;
  const niveaux = new Float32Array(250);        // 5 s de niveaux : plancher de bruit de la ligne
  let niveauxIdx = 0, niveauxN = 0, seuilVoix = SEUIL_SON_RMS, seuilCalculeA = 0, seuilMax = SEUIL_SON_RMS;
  let toursValides = 0, toursIgnores = 0;
  // RELANCE DE SUITE (16/09/2026, appel de Coq) : « Oui, vingt-deux heures est possible. » et plus rien. La reponse
  // ne posait pas de question, le client attendait l'etape suivante, l'agent attendait le client : 5 s de blanc,
  // puis 4,4 s de Grok sur « Très bien », et Coq a raccroche. Apres une reponse sans question, si le client se tait
  // RELANCE_SUITE_MS une fois la lecture finie, l'agent enchaine. Une seule fois par tour du client.
  let attenteSuite = null, relanceSuiteFaite = false;
  let respSeq = 0;         // numero de la reponse en cours : le mark "agentdone" d'une reponse finie ne doit pas rouvrir l'ecoute pendant la suivante
  // FIN DE LECTURE ESTIMEE (16/09/2026) : chaque octet mu-law envoye a Twilio dure 1/8000 s. Le compte a rebours
  // du silence part de la fin REELLE de ce que Lea dit, pas du dernier mot du client : une reponse de 15 s
  // declenchait « Allo, vous etes toujours la ? » juste apres sa derniere phrase.
  let finLecture = 0;
  // ERREUR TWILIO 31924 (16/09/2026) : trois appels de Jacky coupes net pendant que Lea parlait, « Stream -
  // Websocket - Protocol Error ». Un delta audio de Grok peut arriver avec un nombre IMPAIR d'octets : le
  // dernier octet etait perdu (echantillons decales ensuite) et un delta d'un octet donnait un media VIDE.
  // On garde l'octet orphelin pour le delta suivant et on n'envoie jamais de charge vide.
  let resteAudio = Buffer.alloc(0);
  let mediasVides = 0;
  // TRANSFERT (16/09/2026) : null, puis { etat, motif, filet }. « annonce » : l'outil est appele, l'agent
  // dit sa phrase ; « attente » : la phrase est generee, on attend que Twilio ait fini de la jouer (mark
  // "transfert") ; « lance » : l'appel est bascule chez Twilio, le flux va se fermer.
  let transfert = null;
  let agentSpeaking = false, agentSpeakingSince = 0; // half-duplex anti-echo : tant que Dany parle (jusqu'a la fin de lecture Twilio, signalee par le mark "agentdone"), on ne renvoie PAS l'audio a Grok, sinon son propre echo declenche un faux tour et il enchaine les questions

  // Raccroche proprement : on laisse jouer l'audio de cloture deja envoye a Twilio (mark),
  // puis on ferme le flux Twilio -> Twilio termine l'appel -> twilio.on("close") -> finalize() -> recap.
  function requestHangup(reason) {
    if (endRequested || finalized) return;
    endRequested = true;
    endReason = reason;
    console.log(`[call] hangup (${reason}) sid=${callSid}`);
    if (streamSid) { try { twilio.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "hangup" } })); } catch {} }
    setTimeout(() => { try { twilio.close(); } catch {} }, 7000); // filet si Twilio ne renvoie pas le mark
  }

  // Le client parle vraiment par-dessus l'agent : on vide la file Twilio et on jette la suite de la reponse
  // en cours. Plus de response.cancel : la doc xAI le dit non supporte, il ne rendait qu'une erreur.
  function couperAgent(sonMs) {
    if (finalized) return;
    if (streamSid) { try { twilio.send(JSON.stringify({ event: "clear", streamSid })); } catch {} }
    finLecture = Date.now();
    reponseCoupee = respSeq;
    if (doublure?.occupee) doublure.abandonner("le client a coupe");
    pushAgent();
    agentSpeaking = false;
    console.log(`[turn] client coupe l'agent (reponse n°${respSeq}, ${Math.round(sonMs)} ms de voix) ${t()} sid=${callSid}`);
  }

  // Appele a chaque paquet du client (et, en mode grok, au debut de parole signale par Grok). En mode pont, le
  // client parle tant qu'une prise de parole est ouverte : Grok n'entend rien pendant qu'il genere, il ne peut
  // donc plus confirmer, et la fenetre de voix (seuil adapte au bruit de la ligne) suffit.
  function verifierCoupure() {
    if (!bargeIn || finalized || !(TOURS_PAR_LE_PONT ? tour : parleSelonGrok)) return;
    const maintenant = Date.now();
    if (maintenant >= finLecture || maintenant < accueilProtegeJusqua) return; // rien d'audible, ou l'annonce de l'IA
    if (maintenant < mmmJusqua) return; // parler sur le « Mmm » d'attente ne jette pas la reponse qui arrive
    entenduSurAgent = true;
    if (voixRecenteMs > voixMaxTour) voixMaxTour = voixRecenteMs;
    if (voixRecenteMs >= PAROLE_COUPURE_MS && reponseCoupee !== respSeq) {
      coupeCeTour = true;
      if (tour) tour.coupe = true;
      couperAgent(voixRecenteMs);
    }
  }

  // ---- Tours decides par le pont ----
  function envoyerAGrok(paquets) {
    if (!(grok && grok.readyState === WebSocket.OPEN && grokReady)) return;
    for (const p of paquets) {
      if (generation) { retenue.push(p); continue; } // Grok abandonnerait la reponse qu'il genere
      grok.send(JSON.stringify({ type: "input_audio_buffer.append", audio: p.toString("base64") }));
      audioEnvoyeMs += (p.length / 2 / GROK_RATE) * 1000;
    }
  }
  function lacherRetenue() {
    const paquets = retenue;
    retenue = [];
    envoyerAGrok(paquets);
  }
  function marquerGeneration() {
    generation = true;
    generationDemandeeA = Date.now();
  }
  function demanderReponse() {
    if (!(grok && grok.readyState === WebSocket.OPEN)) return;
    marquerGeneration();
    rappelerFinDeQuestion();
    attenteCreation = true; creationDemandeeA = Date.now();
    grok.send(JSON.stringify({ type: "response.create" }));
  }
  // Grok a ignore la demande (tour sans mot reconnu) : la voix retenue repart, rien n'attend plus.
  function reponseIgnoree() {
    attenteCreation = false;
    attenteDepuis = 0; // aucune reponse ne vient : pas de « Mmm »
    if (reponseAnticipee === -1) reponseAnticipee = 0;
    console.log(`[tour] Grok n'a pas cree la reponse en ${Date.now() - creationDemandeeA} ms (aucun mot reconnu ?), la voix du client repart ${t()} sid=${callSid}`);
    if (anticipation) {
      const a = anticipation;
      if (a.annulee) { finirAnnulation(null); return; }
      // Rien n'a ete cree, donc rien a effacer. Le tour n'avait pas de mot : a sa fin, il sera ignore,
      // sauf si de la vraie voix suit (sansMot garde la voix mesuree a ce moment-la).
      anticipation = null;
      a.tour.sansMot = a.tour.voixMs;
      toursValides--;
    }
    generation = false; reponseActive = false;
    lacherRetenue();
    if (tourEnAttente && !tour) { validerTour(); demanderReponse(); }
  }

  // ---- Reponse anticipee (voir ANTICIPATION_MS) ----
  const sansMot = (tr) => tr.sansMot !== undefined && tr.voixMs - tr.sansMot < ANNULATION_VOIX_MS;
  let reponseAnticipee = 0, anticipeePreteA = 0; // pour le journal de latence de la reponse confirmee
  // Seul un tour que finDuTour validerait est anticipe, et jamais pendant que l'agent est audible.
  function peutAnticiper(maintenant) {
    if (!ANTICIPATION_MS || finDeTourMs - ANTICIPATION_MS < 200) return false;
    if (!tour || sansMot(tour) || anticipation || generation || outilsEnCours || tourEnAttente || transfert || endRequested) return false;
    if (!(grok && grok.readyState === WebSocket.OPEN && grokReady)) return false;
    if (maintenant - tour.derniereVoix < ANTICIPATION_MS || maintenant < finLecture) return false;
    const agentContinue = !tour.coupe && finLecture > tour.derniereVoix + 500;
    const voixMinimale = tour.derniereVoix < accueilProtegeJusqua ? PAROLE_ACCUEIL_MS : PAROLE_COUPURE_MS;
    return !(tour.voixMs < 150 || (agentContinue && (tour.voixMs < voixMinimale || !bargeIn)));
  }
  function lancerAnticipation() {
    anticipation = { tour, etat: "demandee", annulee: false, annuleeA: 0, voixDepuis: 0, audio: [], pretA: 0, fin: null, items: [], closingAvant: closingSaid, depuis: Date.now() };
    console.log(`[tour] anticipe : ${Math.round(tour.voixMs)} ms de voix, dernier son a t+${((tour.derniereVoix - debutAppelMs) / 1000).toFixed(2)}, reponse lancee ${t()}`);
    validerTour();
    demanderReponse();
  }
  // Fin du tour confirmee : le son deja pret part, et ce qui attendait la fin de la reponse suit.
  function confirmerAnticipation(fini) {
    const a = anticipation;
    anticipation = null;
    retenue = []; // la fin du tour : du silence ou des sons trop brefs pour compter, comme un son ignore
    finParoleClientMs = fini.derniereVoix;
    console.log(`[tour] client : ${Math.round(fini.voixMs)} ms de voix, dernier son a t+${((fini.derniereVoix - debutAppelMs) / 1000).toFixed(2)}, reponse anticipee ${a.etat === "demandee" ? "pas encore creee" : a.audio.length ? "prete" : "en cours"} ${t()}`);
    reponseAnticipee = a.etat === "demandee" ? -1 : respSeq; // -1 : numerotee a sa creation
    anticipeePreteA = a.pretA;
    attenteDepuis = fini.derniereVoix;
    for (const u of a.audio) envoyerSonAgent(u);
    if (a.etat === "finie") terminerReponse(a.fin);
  }
  // Le client reprend : la reponse lancee trop tot est annulee, puis effacee (finirAnnulation).
  function annulerAnticipation(pourquoi) {
    const a = anticipation;
    if (!a || a.annulee) return;
    a.annulee = true;
    a.annuleeA = Date.now();
    toursValides--;
    console.log(`[tour] anticipation annulee : ${pourquoi} ${t()}`);
    if (a.etat === "finie") { finirAnnulation(null); return; }
    // Envoye avant response.created, l'annulation s'applique a la reponse des sa creation (banc du 17/09).
    if (grok && grok.readyState === WebSocket.OPEN) grok.send(JSON.stringify({ type: "response.cancel" }));
  }
  function finirAnnulation(e) {
    const a = anticipation;
    anticipation = null;
    if (e) console.log(`[reponse] n°${respSeq} statut=${e.response?.status || "?"} (anticipation annulee) texte=${agentBuf.length}car ${t()} sid=${callSid}`);
    // Grok ne doit garder aucune trace de la reponse lancee trop tot : son message et ses appels d'outil s'effacent.
    // Le message du client, lui, reste : la suite de la phrase s'y ajoute (voir ANTICIPATION_MS).
    const aEffacer = a.items.filter((id) => itemsAjoutes.has(id));
    if (grok && grok.readyState === WebSocket.OPEN) {
      for (const id of aEffacer) { suppressionsEnCours++; grok.send(JSON.stringify({ type: "conversation.item.delete", item_id: id })); }
    }
    pendingCalls = []; agentBuf = ""; closingSaid = a.closingAvant;
    reponseCoupee = respSeq; agentSpeaking = false;
    // La ligne du client reservee avec la phrase partielle : la transcription de la phrase entiere la remplacera.
    if (tourClient && tourClient.idx != null && tourClient.idx === dialog.length - 1 && dialog[tourClient.idx].who === "Client") dialog.pop();
    tourClient = null; userBuf = "";
    reponseActive = false; generation = false; attenteCreation = false;
    const suite = retenue.length;
    lacherRetenue();
    console.log(`[tour] anticipation effacee (${aEffacer.length} element${aEffacer.length > 1 ? "s" : ""}), la suite de la phrase repart (${(suite * 0.02).toFixed(1)} s) ${t()}`);
    if (tourEnAttente && !tour) { validerTour(); demanderReponse(); }
  }
  // Fin d'une reponse de Grok : journal, queue de silence, outils, relances. Differee pour une reponse anticipee.
  function terminerReponse(e) {
    // Reponse trop courte pour avoir ete tranchee : on la laisse passer plutot que de la perdre.
    if (!rediteTranchee && retenueRedite.length) { rediteTranchee = true; const g = retenueRedite; retenueRedite = []; for (const u of g) envoyerSonAgent(u); }
    rediteTranchee = true;
    // Ce qui vient d'etre dit est consomme : la prochaine reponse aura besoin d'une entree a elle. ⚠ Ne PAS
    // remettre ce drapeau a chaque validation de tour : une anticipation annulee revalide le meme tour, dont la
    // transcription est deja arrivee et ne reviendra pas, et on jetterait une reponse parfaitement legitime.
    // Consommee meme si le client a coupe : il a coupe pour dire autre chose, la prochaine reponse repondra
    // a CETTE nouvelle parole. Sans cela, une reponse coupee laissait son entree disponible et la suivante
    // pouvait la redire (banc : la reponse sur le gluten dite deux fois).
    if (agentBuf.trim()) consommerEntreeClient();
    const texteReponse = agentBuf;
    // Surveillance des fins avalees : une transcription de Grok qui finit sans ponctuation a perdu son dernier signe,
    // et sa derniere syllabe avec (voir TYPO_COLLEE). Hors reponse coupee par le client, qui s'arrete forcement net.
    if (texteReponse.trim() && respSeq !== reponseCoupee && !/[.?!…»"')\]]\s*$/.test(texteReponse.trim())) {
      console.log(`[coupure] fin avalee probable n°${respSeq} : « …${texteReponse.trim().slice(-70)} » ${t()} sid=${callSid}`);
    }
    // JOURNAL PAR REPONSE (16/09/2026) : une phrase d'accueil de 17 s s'est arretee au milieu chez le client
    // alors que la transcription etait complete, et rien dans le journal ne permettait de dire si Grok avait
    // tronque l'audio ou si la ligne l'avait perdu. Le statut de Grok, ses details, les secondes d'audio
    // reellement envoyees a Twilio et la duree de generation le disent en une ligne.
    const r = e.response || {};
    console.log(`[reponse] n°${respSeq} statut=${r.status || "?"}${r.status_details ? " " + JSON.stringify(r.status_details).slice(0, 200) : ""} audio=${(audioReponseOctets / 8000).toFixed(1)}s generee_en=${((Date.now() - debutReponseMs) / 1000).toFixed(1)}s texte=${texteReponse.length}car${pendingCalls.length ? " outils=" + pendingCalls.map((c) => c.name).join(",") : ""}${r.usage ? " usage=" + JSON.stringify(r.usage).slice(0, 200) : ""} ${t()} sid=${callSid}`);
    // La doublure parle a la place de cette reponse : c'est SON `finie` qui cloturera le tour, quand son texte
    // aura ete injecte dans la primaire. Jusque-la, la generation reste ouverte et le client attend.
    if (doublureGagnante) { reponseActive = false; return; }
    if (TOURS_PAR_LE_PONT) { reponseActive = false; generation = false; lacherRetenue(); } // Grok peut de nouveau entendre le client
    // Une reponse coupee par le client n'a pas ete entendue en entier : elle ne compte pas comme dite.
    if (texteReponse.trim() && respSeq !== reponseCoupee) repliqueEnCours = `${repliqueEnCours} ${texteReponse.trim()}`.trim().slice(-4000);
    pushAgent();
    if (RECAP_RE.test(texteReponse) || (/euro/i.test(texteReponse) && /\?/.test(texteReponse))) { recapTs = Date.now(); clientApresRecap = false; }
    // Dany a fini de GENERER, mais Twilio joue encore l'audio en file. On rouvre l'ecoute seulement au mark "agentdone"
    // (renvoye par Twilio quand la lecture est vraiment finie), pas maintenant, sinon on capte la fin de son propre audio.
    // QUEUE DE SILENCE (17/09/2026, appel de Coq) : « À quelle heure souhaitez-vous la retir… ». Ni coupure du
    // pont ni parole du client : l'audio de Grok s'arrete sur la derniere syllabe, sans aucun silence apres
    // (energie encore forte dans ses 150 dernieres ms, banc du 17/09), et la fin se perd sur le trajet
    // telephonique. 300 ms de silence derriere chaque reponse laissent a la ligne le temps de la jouer.
    if (streamSid && audioReponseOctets > 0 && respSeq !== reponseCoupee && twilio.readyState === WebSocket.OPEN) {
      const silence = Buffer.alloc(2400, 0xff); // mu-law 0xFF = zero, 300 ms a 8 kHz
      twilio.send(JSON.stringify({ event: "media", streamSid, media: { payload: silence.toString("base64") } }));
      finLecture = Math.max(finLecture, Date.now()) + 300;
    }
    if (streamSid) twilio.send(JSON.stringify({ event: "mark", streamSid, mark: { name: `agentdone:${respSeq}` } }));
    const calls = pendingCalls.splice(0);
    const phrase = texteReponse.trim();
    // Seulement une reponse de relance apres outil : la transcription de Grok omet souvent le « ? » final
    // (« Que désirez-vous commander »), et la relance partait a tort sur une vraie question.
    // Question reconnue meme sans « ? » : « À quelle heure souhaitez-vous la retirer » faisait partir la relance,
    // et l'agent enchainait sur une autre question (« Quelle pizza désirez-vous ? ») avant la reponse.
    // Les deux dernieres phrases : l'agent ajoute maintenant « Je vous écoute. » apres sa question.
    const deuxDernieres = phrase.split(/(?<=[.!?…])\s+/).slice(-2).map((p) => p.trim());
    const estQuestion = deuxDernieres.some((p) => /\?/.test(p)
      || /-(vous|je|tu|il|elle|on|nous|ils|elles)\b/i.test(p)
      || /^(quel|quelle|quels|quelles|combien|comment|où|quand|pourquoi|est-ce|qu'est-ce|à quel|a quel|pour quel|c'est pour quel|que (désirez|souhaitez|voulez|prenez)|dites-moi)/i.test(p));
    attenteSuite = TOURS_PAR_LE_PONT && reponseApresOutil && !calls.length && phrase && !estQuestion && !closingSaid && !closeTriggered && !relanceSuiteFaite ? { respSeq } : null;
    // La phrase d'annonce du transfert vient d'etre generee : on attend qu'elle soit jouee, puis on bascule.
    if (!calls.length && transfert && transfert.etat === "annonce") preparerTransfert();
    // Plus rien n'arrive pour ce tour (ni outil, ni reponse a un tour en attente) : pas de « Mmm » apres coup.
    if (!calls.length && !(TOURS_PAR_LE_PONT && tourEnAttente && !tour)) attenteDepuis = 0;
    if (calls.length) runTools(calls).catch((err) => console.error("[outil] echec du cycle", err));
    else if (TOURS_PAR_LE_PONT && tourEnAttente && !tour) { validerTour(); demanderReponse(); } // le client a parle pendant la generation
    else if ((pizzeria || commandesParDaleVoz()) && !clotureVerifiee) {
      const consigne = commandesParDaleVoz()
        ? consigneClotureCommande(texteReponse, { outils: calls.map((c) => c.name), dejaEnregistree: commandeEnregistreeDV })
        : pizzeria.consigneCloture(texteReponse, { callSid, outils: calls.map((c) => c.name) });
      if (consigne) {
        clotureVerifiee = true; closingSaid = false;
        console.log(`[garde] commande annoncee sans enregistrement sid=${callSid}`);
        dialog.push({ who: "Garde", msg: "commande annoncée sans enregistrement, consigne renvoyée" });
        promptGrok(consigne);
      }
    }
    if (closeTriggered && !endRequested) requestHangup("cloture polie");
  }
  // Le client attend et rien ne sort encore : « Mmm… » (voir MMM_APRES_MS). Joue une fois par tour du client,
  // par paquets de 100 ms, et compte comme audible pour la fin de lecture.
  function jouerMmm(maintenant) {
    const depuis = maintenant - attenteDepuis;
    attenteDepuis = 0;
    if (!sonMmm || !streamSid || twilio.readyState !== WebSocket.OPEN) return;
    for (let o = 0; o < sonMmm.length; o += 800) {
      twilio.send(JSON.stringify({ event: "media", streamSid, media: { payload: sonMmm.subarray(o, o + 800).toString("base64") } }));
    }
    finLecture = Math.max(finLecture, maintenant) + (sonMmm.length / 8000) * 1000;
    mmmJusqua = finLecture;
    mmmAvantReponse = true;
    console.log(`[attente] « ${MMM_TEXTE} » ${depuis} ms apres la fin de parole du client ${t()} sid=${callSid}`);
  }
  // Un paquet d'ambiance de salle vers Twilio, au rythme des paquets entrants (voir AMBIANCE_APRES_MS).
  // Ne touche NI finLecture NI attenteDepuis : ce fond n'est pas la parole de l'agent, il ne rend le pont
  // ni sourd ni occupe, et la vraie reponse passe devant sans rien avoir a purger.
  function jouerAmbiance(maintenant, octets) {
    if (!ambianceBoucle || !streamSid || twilio.readyState !== WebSocket.OPEN) return;
    if (!ambianceDepuis) { ambianceDepuis = maintenant; console.log(`[ambiance] blanc comble ${maintenant - attenteDepuis} ms apres la fin de parole du client ${t()} sid=${callSid}`); }
    const n = Math.min(octets, 800);
    if (ambiancePos + n > ambianceBoucle.length) ambiancePos = 0;
    twilio.send(JSON.stringify({ event: "media", streamSid, media: { payload: ambianceBoucle.subarray(ambiancePos, ambiancePos + n).toString("base64") } }));
    ambiancePos += n;
    ambianceMs += (n / 8000) * 1000;
  }
  function arreterAmbiance(maintenant) {
    if (!ambianceDepuis) return;
    console.log(`[ambiance] ${maintenant - ambianceDepuis} ms de fond joues ${t()} sid=${callSid}`);
    ambianceDepuis = 0;
  }
  // ---- Doublure (voir HEDGE_APRES_MS et lib/doublure.js) ----
  // Les deux sessions doivent avoir le meme historique, et une seule entend le client. `dialog` est deja la
  // transcription ordonnee de l'appel : on y avance un curseur et on pousse dans la doublure ce qu'elle n'a pas
  // encore. Paresseux et sans trou, meme sur les tours ou elle n'a pas ete sollicitee.
  function synchroniserDoublure() {
    if (!doublure) return;
    // La ligne du tour en cours n'est remplie qu'a l'arrivee de la transcription : on ne pousse que ce qui est dit.
    while (doublureSyncIdx < dialog.length) {
      const l = dialog[doublureSyncIdx];
      if (!l.msg || !l.msg.trim()) { if (doublureSyncIdx < dialog.length - 1) { doublureSyncIdx++; continue; } break; }
      if (l.who === "Client") doublure.client(l.msg);
      else if (l.who === "Agent") doublure.agent(l.msg);
      doublureSyncIdx++;
    }
  }
  // La primaire est muette depuis trop longtemps : on demande la meme reponse a la doublure.
  function demanderDoublure(maintenant) {
    if (!doublure || !doublure.prete || doublure.occupee) return;
    synchroniserDoublure();
    if (!doublure.demander(respSeq)) return;
    doublureTour = respSeq;
    doublureDemandees++;
    console.log(`[doublure] demandee pour la reponse n°${respSeq}, muette depuis ${maintenant - debutReponseMs} ms ${t()} sid=${callSid}`);
  }
  // La doublure a parle la premiere : sa reponse devient LA reponse. On jette celle de la primaire (rien n'en
  // a ete entendu, elle n'a pas sorti un octet) et on lui fera dire le texte de la doublure a la fin du tour,
  // pour qu'elle ne le redise pas au tour suivant.
  function doublurePrendLaMain() {
    if (doublureGagnante) return true;
    if (premierSon || audioReponseOctets > 0) return false; // la primaire a parle la premiere
    doublureGagnante = true;
    doublureGagnees++;
    // Les deltas de la primaire sont jetes a partir d'ici. ⚠ NE PAS se servir de `reponseCoupee` pour ca : il
    // sert aussi de garde a la coupure de parole (`reponseCoupee !== respSeq`), et le client ne pouvait alors
    // plus couper une reponse doublee. Appel de controle du 17/09 : « Très bien, je vous rappellerai » n'a rien
    // arrete, la file Twilio n'a pas ete purgee, et la fin de la doublure s'est melee a la reponse suivante.
    primaireJetee = respSeq;
    try { grok.send(JSON.stringify({ type: "response.cancel" })); } catch {}
    agentBuf = "";                            // son texte n'a pas ete dit
    // La primaire ne sait pas encore ce que la doublure est en train de dire : elle ne le saura qu'a la fin,
    // quand on le lui injectera. Tant que ce n'est pas fait, le client ne doit pas lui arriver, sinon elle
    // repond a la question suivante SANS avoir la reponse precedente et redit tout (constate au banc : la
    // liste des pizzas au jambon dite deux fois). `generation` retient deja l'audio du client pour ca.
    marquerGeneration();
    console.log(`[doublure] prend la main sur la reponse n°${respSeq}, ${Date.now() - debutReponseMs} ms apres sa creation ${t()} sid=${callSid}`);
    return true;
  }
  function ouvrirDoublure({ modele, vitesse, effort, sessionInstructions, outils }) {
    doublure = creerDoublure({
      cle: XAI_API_KEY,
      modele,
      etiquette: `sid=${callSid}`,
      config: {
        instructions: sessionInstructions,
        ...(outils.length ? { tools: outils, tool_choice: "auto" } : {}),
        voice: sessionDV?.voice || GROK_VOICE,
        reasoning: { effort },
        audio: {
          input: { format: { type: "audio/pcm", rate: GROK_RATE }, turn_detection: null },
          output: { format: { type: "audio/pcm", rate: GROK_RATE }, speed: vitesse },
        },
      },
      sur: {
        son: (pcm, tourDoublure) => {
          // Le tour a change (le client a repris, la primaire a fini) : ce son n'a plus lieu d'etre.
          if (tourDoublure.marque !== respSeq || tourDoublure.outil) return;
          if (reponseCoupee === respSeq) return; // le client a coupe : la suite ne part plus, comme pour la primaire
          if (!doublurePrendLaMain()) return;
          const brut = Buffer.concat([resteAudioDoublure, pcm]);
          const pair = brut.length - (brut.length % 2);
          resteAudioDoublure = Buffer.from(brut.subarray(pair));
          if (pair === 0) return;
          const ulaw = pcm16ToUlaw8k(Buffer.from(brut.subarray(0, pair)), GROK_RATE);
          if (ulaw.length) envoyerSonAgent(ulaw);
        },
        outil: (nom, tourDoublure) => {
          console.log(`[doublure] abandonnee : elle demande l'outil ${nom} (reponse n°${tourDoublure.marque}) ${t()} sid=${callSid}`);
          doublure.abandonner("outil demande");
        },
        finie: (statut, tourDoublure) => {
          resteAudioDoublure = Buffer.alloc(0);
          if (!doublureGagnante || tourDoublure.marque !== respSeq) return;
          // Ce que la doublure a dit doit devenir l'historique de la PRIMAIRE, sinon elle le redirait au tour
          // suivant. L'injection en role assistant est acceptee et relue fidelement (banc du 17/09). La
          // doublure, elle, le recevra par le curseur sur `dialog` : ne pas le lui poser deux fois.
          const texte = (tourDoublure.texte || "").trim();
          if (texte) {
            try { grok.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: texte }] } })); } catch {}
            pushLine("Agent", texte);
            consommerEntreeClient(); // la doublure a repondu : l'entree du tour est consommee, coupee ou non
            // Coupee par le client : le tour n'a pas ete entendu en entier, il ne compte pas comme dit (meme
            // regle que pour la primaire, cf. terminerReponse).
            if (reponseCoupee !== tourDoublure.marque) {
              repliqueEnCours = `${repliqueEnCours} ${texte}`.trim().slice(-4000);
              if (CLOSING_RE.test(texte)) closingSaid = true;
            }
          }
          console.log(`[doublure] reponse n°${tourDoublure.marque} finie (${statut}), ${texte.length} car${reponseCoupee === tourDoublure.marque ? ", coupee par le client" : ""}${texte ? ` : « ${texte.slice(0, 120)} »` : ""} ${t()} sid=${callSid}`);
          // Fin du tour, maintenant que la primaire sait ce qui a ete dit : elle peut de nouveau entendre le
          // client, et repondre a ce qu'il a dit pendant que la doublure parlait.
          doublureGagnante = false;
          generation = false;
          lacherRetenue();
          // ⚠⚠ La queue de silence ET le mark de fin de lecture sont d'ordinaire poses par terminerReponse,
          // que la doublure court-circuite. Sans la queue, la derniere syllabe de sa reponse se perd sur la
          // ligne ; sans le mark, un pont en DEMI-DUPLEX reste sourd jusqu'a son filet (12 s de blanc mesurees
          // sur un vrai appel de Dany). Il faut donc les refaire ici, a l'identique.
          if (streamSid && audioReponseOctets > 0 && reponseCoupee !== tourDoublure.marque && twilio.readyState === WebSocket.OPEN) {
            const silence = Buffer.alloc(2400, 0xff); // mu-law 0xFF = zero, 300 ms a 8 kHz
            twilio.send(JSON.stringify({ event: "media", streamSid, media: { payload: silence.toString("base64") } }));
            finLecture = Math.max(finLecture, Date.now()) + 300;
          }
          if (streamSid) twilio.send(JSON.stringify({ event: "mark", streamSid, mark: { name: `agentdone:${tourDoublure.marque}` } }));
          if (tourEnAttente && !tour) { validerTour(); demanderReponse(); }
        },
      },
    });
    doublure.ouvrir().then((ok) => { if (!ok) doublure = null; });
  }
  // REDITE (voir `entreeNouvelle`). Une reponse dont le tour n'a apporte AUCUN message nouveau ne peut etre que
  // la precedente redite : son son n'est pas joue et la reponse est annulee. Tant que le doute subsiste, le son
  // attend, et cette attente ne concerne QUE les tours sans entree connue (un « mmm », un souffle, un bruit de
  // ligne) : un tour normal, dont la transcription est arrivee, n'est pas retarde d'une milliseconde.
  function trancherRedite() {
    if (rediteTranchee) return true;
    if (entreeNouvelle || !REDITE_ATTENTE_MS) { rediteTranchee = true; return true; }
    // La transcription arrive ~400 ms apres le commit et le premier son a 0,6-1,4 s : elle est donc presque
    // toujours deja la. On laisse quand meme REDITE_ATTENTE_MS de battement avant de conclure, pour ne pas
    // jeter une vraie reponse le jour ou la transcription tarde ou manque.
    if (!retenueDepuis) retenueDepuis = Date.now();
    if (Date.now() - retenueDepuis < REDITE_ATTENTE_MS) return false; // le son attend
    rediteTranchee = true;
    retenueRedite = [];
    reponseCoupee = respSeq; // la suite du son est jetee, comme pour une reponse coupee
    const debut = agentBuf.trim();
    agentBuf = "";
    try { grok.send(JSON.stringify({ type: "response.cancel" })); } catch {}
    console.log(`[redite] reponse n°${respSeq} jetee : le tour ne portait aucun mot, elle disait « ${debut.slice(0, 70)}… » ${t()} sid=${callSid}`);
    return false;
  }
  // Son de l'agent vers Twilio, et mesure de la latence au premier son de chaque reponse.
  function envoyerSonAgent(ulaw) {
    // Rien ne part tant qu'on ne sait pas si cette reponse est une redite (voir trancherRedite).
    if (!rediteTranchee) {
      retenueRedite.push(ulaw);
      if (!trancherRedite()) return;
      const gardes = retenueRedite;
      retenueRedite = [];
      for (const u of gardes) envoyerSonAgent(u);
      return;
    }
    attenteDepuis = 0;
    arreterAmbiance(Date.now());
    // La primaire a parle la premiere : la doublure n'a plus lieu d'etre, et son son ne doit surtout pas
    // s'ajouter derriere. (Quand c'est ELLE qui parle, doublureGagnante est deja vrai.)
    if (!doublureGagnante && doublure?.occupee) doublure.abandonner("la primaire a parle");
    twilio.send(JSON.stringify({ event: "media", streamSid, media: { payload: ulaw.toString("base64") } }));
    finLecture = Math.max(finLecture, Date.now()) + (ulaw.length / 8000) * 1000;
    audioReponseOctets += ulaw.length;
    if (!premierSon) {
      // LATENCE MESUREE : ce que l'appelant attend vraiment, depuis la fin de sa phrase.
      premierSon = true;
      if (accueilProtegeJusqua === Infinity) accueilProtegeJusqua = Date.now() + (respSeq === 1 ? ACCUEIL_PROTEGE_MS : 0);
      console.log(`[latence] n°${respSeq} premier son ${Date.now() - debutReponseMs} ms apres la creation${finParoleClientMs ? `, ${Date.now() - finParoleClientMs} ms apres la fin de parole du client` : ""}${respSeq === reponseAnticipee ? ` (anticipee${anticipeePreteA ? `, prete ${anticipeePreteA - debutReponseMs} ms apres la creation` : ""})` : ""}${mmmAvantReponse ? " (apres « Mmm »)" : ""} ${t()} sid=${callSid}`);
      finParoleClientMs = 0;
      mmmAvantReponse = false;
    }
  }
  // GROK AVALE LA FIN DES QUESTIONS (17/09/2026, mesure) : une reponse qui se termine sur une question finit
  // abruptement, les dernieres syllabes manquent DANS SON AUDIO (« Allora, que désirez-vous commander ? » : 5 fins
  // coupees sur 5, sur les 9 voix feminines ; une affirmation : 0 sur 5). La meme question suivie de « Je vous
  // écoute ! » : 0 sur 5. La consigne de session ne suffit pas (le modele l'oublie deux fois sur cinq) ; rappelee
  // juste avant chaque reponse, les questions ont fini proprement 4 fois sur 4.
  // ⚠ RETIRE le 17/09 a 08:36 : en appel reel, ce message systeme avant chaque reponse a fait repeter l'accueil
  // puis repondre « Je vous écoute. » a tout. Le banc a quatre tours ne l'avait pas montre. Garde a zero.
  function rappelerFinDeQuestion() {
    if (process.env.RAPPEL_FIN_QUESTION !== "1") return;
    if (!TOURS_PAR_LE_PONT || !(grok && grok.readyState === WebSocket.OPEN)) return;
    grok.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: "Rappel pour ta prochaine réponse : si elle contient une question, ne termine pas sur la question. Ajoute après elle deux ou trois mots comme « Je vous écoute. » ou « Dites-moi. »" }] } }));
  }
  // La prise de parole devient un message du client dans la conversation de Grok.
  function validerTour() {
    tourEnAttente = false;
    messageTransmisSansReponse = false; // le client a repondu apres le message transmis : raccrocher redevient possible
    // La parole du client clot ce que l'agent venait de dire (une anticipation annulee revalide sans rien effacer).
    if (repliqueEnCours) { repliqueAvantClient = repliqueEnCours; repliqueEnCours = ""; }
    if (!(grok && grok.readyState === WebSocket.OPEN)) return;
    grok.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    tourClient = { idx: null };
    if (recapTs) clientApresRecap = true;
    relancesOutils = 0;
    relanceSuiteFaite = false;
    checkedIn = false;
    toursValides++;
  }
  function finDuTour() {
    const fini = tour;
    tour = null;
    if (anticipation && anticipation.tour === fini && !anticipation.annulee) { confirmerAnticipation(fini); return; }
    // L'agent parle encore bien apres ce son : « mmm », « oui », un souffle. Sans coupure possible (demi-duplex),
    // tout ce qui est dit par-dessus l'agent est ignore, comme quand l'audio ne partait pas a Grok.
    const agentContinue = !fini.coupe && finLecture > fini.derniereVoix + 500;
    const pendantAccueil = fini.derniereVoix < accueilProtegeJusqua; // l'annonce de l'IA ne se coupe pas
    const voixMinimale = pendantAccueil ? PAROLE_ACCUEIL_MS : PAROLE_COUPURE_MS;
    // sansMot : l'anticipation de ce tour a montre que Grok n'y reconnaissait aucun mot, et rien n'a suivi.
    if (sansMot(fini) || fini.voixMs < 150 || (agentContinue && (fini.voixMs < voixMinimale || !bargeIn))) {
      toursIgnores++;
      console.log(`[tour] son ignore : ${Math.round(fini.voixMs)} ms de voix${sansMot(fini) ? " sans mot reconnu" : ""}${agentContinue ? " pendant que l'agent parle" : ""} ${t()}`);
      if (tourEnAttente) {
        // Une vraie prise de parole attend d'etre validee et son audio est dans le meme tampon : on garde le
        // tout (le son bref ne gene pas la transcription) plutot que d'effacer la question avec.
        if (!(generation || outilsEnCours)) { validerTour(); demanderReponse(); }
        return;
      }
      if (generation) retenue = []; // rien d'autre n'est retenu que ce son
      else if (grok && grok.readyState === WebSocket.OPEN) grok.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
      userBuf = "";
      return;
    }
    finParoleClientMs = fini.derniereVoix;
    attenteDepuis = fini.derniereVoix;
    const occupe = generation || outilsEnCours;
    console.log(`[tour] client : ${Math.round(fini.voixMs)} ms de voix, dernier son a t+${((fini.derniereVoix - debutAppelMs) / 1000).toFixed(2)}${occupe ? ", valide apres la reponse en cours" : ""} ${t()}`);
    if (occupe) { tourEnAttente = true; return; }
    validerTour();
    demanderReponse();
  }

  // Anti-doublons : la transcription Grok est cumulative et peut etre flushee plusieurs fois
  // par tour (pauses + barge-in). Si la nouvelle ligne prolonge la precedente du meme locuteur, on remplace.
  function pushLine(who, raw) {
    const t = (raw || "").trim();
    if (!t) return;
    const last = dialog[dialog.length - 1];
    if (last && last.who === who) {
      const a = normLine(last.msg), b = normLine(t);
      if (a && b && (b.startsWith(a) || a.startsWith(b))) { last.msg = t.length >= last.msg.length ? t : last.msg; return; }
    }
    dialog.push({ who, msg: t });
  }
  // Ligne client du tour en cours. La transcription arrive souvent APRES response.created : on reserve
  // alors la place de la ligne pour qu'elle reste avant la reponse de l'agent, et on la remplit ensuite.
  let tourClient = null; // { idx } depuis le dernier speech_started
  function pushUser() {
    if (!tourClient || tourClient.idx != null) { if (userBuf.trim()) pushLine("Client", userBuf); userBuf = ""; return; }
    tourClient.idx = dialog.length;
    dialog.push({ who: "Client", msg: userBuf.trim() });
    userBuf = "";
  }
  // Une transcription du client : y a-t-il de quoi repondre, c'est-a-dire un message que l'agent n'a pas
  // deja utilise ? Un message vide (bruit sans mot) ne compte pas, un message deja servi non plus.
  function noterEntreeClient(itemId, texte) {
    if (itemId) dernierItemClient = itemId;
    if (String(texte || "").trim() && dernierItemClient && dernierItemClient !== itemClientConsomme) entreeNouvelle = true;
  }
  function consommerEntreeClient() {
    itemClientConsomme = dernierItemClient;
    entreeNouvelle = false;
  }
  function setUser(texte, cumule) {
    if (typeof texte !== "string") return;
    if (tourClient && tourClient.idx != null && dialog[tourClient.idx]) {
      const l = dialog[tourClient.idx];
      l.msg = (cumule ? l.msg + texte : texte).replace(/^\s+/, "");
    } else userBuf = cumule ? userBuf + texte : texte;
  }
  function pushAgent() { pushLine("Agent", agentBuf); agentBuf = ""; }

  async function openGrok() {
    // L'agent joué vient de Dale Voz quand le numéro appelé y est rattaché ;
    // sinon le pont garde sa configuration locale (prompt en fichier), ce qui
    // fait tourner Motralec et Palazzo tant que leur numéro n'est pas branché.
    if (dalevozActif && toNumber) {
      canalDV = (await resoudreNumero(toNumber)).canal ?? null;
      if (canalDV) {
        sessionDV = await chargerSession({
          tenantId: canalDV.tenantId,
          agentSlug: canalDV.agentSlug,
          locale: canalDV.locale,
        });
        if (!sessionDV) console.error(`[dalevoz] config introuvable pour ${canalDV.agentSlug}, repli sur la config locale`);
        else {
          if (typeof sessionDV.telephone?.couperLaParole === "boolean") bargeIn = sessionDV.telephone.couperLaParole;
          console.log(`[dalevoz] agent ${canalDV.agentSlug} (${sessionDV.tools?.length ?? 0} outils, coupure ${bargeIn ? "oui" : "non"}) pour ${toNumber}`);
        }
        // Ce que la tablette du restaurant a regle (pause, ruptures...) doit etre dans le contexte
        // de CET appel, qui part juste apres. Plafonne : un Dale Voz lent ne retarde pas le decroche.
        if (pizzeria && !commandesParDaleVoz()) {
          const t0 = Date.now();
          await Promise.race([pizzeria.rafraichir({ tenantId: canalDV.tenantId, agentSlug: canalDV.agentSlug }, { forcer: true }), new Promise((r) => setTimeout(r, 1500))]);
          console.log(`[restaurant] etat relu en ${Date.now() - t0} ms`);
        }
      }
    }
    let token;
    try {
      const tok = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
        method: "POST",
        headers: { Authorization: `Bearer ${XAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expires_after: { seconds: 600 } }),
      }).then((r) => r.json());
      token = tok.value || tok.secret || tok.token || (tok.client_secret && tok.client_secret.value);
    } catch (e) {
      console.error("[grok] token error", e);
      return;
    }
    if (!token) { console.error("[grok] pas de token"); return; }

    // Le modele, la vitesse et le seuil VAD viennent de l'onglet Voix de l'agent Dale Voz quand il y en a un.
    const modele = sessionDV?.model || GROK_MODEL;
    const vitesse = Number(sessionDV?.speed) || GROK_SPEED;
    const seuilVad = Number(sessionDV?.threshold) || GROK_VAD_THRESHOLD;
    if (Number(sessionDV?.silenceMs) > 0) finDeTourMs = Math.min(1500, Math.max(500, Number(sessionDV.silenceMs)));
    if (TOURS_PAR_LE_PONT && MMM_APRES_MS > 0) sonDAttente(sessionDV?.voice || GROK_VOICE, vitesse).then((s) => { sonMmm = s; });
    grok = new WebSocket(`wss://api.x.ai/v1/realtime?model=${modele}`, [`xai-client-secret.${token}`]);

    grok.on("open", () => {
      const callerFr = frPhone(fromNumber);
      const callerSpoken = callerFr ? frPhoneSpoken(callerFr) : "";
      const instructionsBase = sessionDV?.instructions || RECEPTION_PROMPT;
      // LA CARTE DANS LA SESSION (16/09/2026). Branche sur Dale Voz, l'agent cherchait chaque question sur les
      // pizzas dans la base de connaissance : « Je vais vérifier ça pour vous », un outil, puis une seconde
      // reponse, soit deux a trois secondes de plus au telephone (et une fois 11 s de silence). La carte qui
      // chiffre les commandes est deja dans le pont : on la donne, sauf si le prompt la contient deja.
      // Commandes par Dale Voz : la carte et l'etat du restaurant sont deja dans les instructions publiees.
      const profilLocal = Boolean(pizzeria) && !commandesParDaleVoz();
      const carte = profilLocal ? pizzeria.carteTexte() : "";
      const premiereLigneCarte = carte.split("\n").find((l) => l.startsWith("- ")) || "";
      const carteAjoutee = carte && !(premiereLigneCarte && instructionsBase.includes(premiereLigneCarte))
        ? `La carte complète et à jour, avec les prix, est ci-dessous. Pour une question sur les pizzas, les formules, les desserts, les boissons, leurs ingrédients ou leurs prix, réponds directement à partir d'elle, sans outil de recherche et sans annoncer que tu vérifies.\n\n${carte}`
        : "";
      const contexte = [
        profilLocal ? pizzeria.contexteAppel() : "",
        callerFr ? `Le client appelle depuis le numéro ${callerFr}. Quand tu lui relis ce numéro à voix, tu prononces EXACTEMENT ceci, mot pour mot, sans le recalculer ni changer un seul groupe : « ${callerSpoken} ». C'est son numéro de rappel par défaut, tu le connais déjà.` : "",
        carteAjoutee,
        "Au téléphone, un silence de ta part laisse le client dans le vide. Ne termine jamais une réponse sur une simple confirmation (« Oui, vingt-deux heures est possible. ») : enchaîne dans la même réponse sur l'étape suivante, par une question. Seul l'au revoir final ne pose pas de question.",
        "Au téléphone, ta voix avale la fin d'une réponse qui se termine sur une question. Ne finis donc jamais sur le point d'interrogation : après ta question, ajoute toujours deux ou trois mots, variés d'une fois sur l'autre (« Je vous écoute. », « Dites-moi. », « Prenez votre temps. »).",
        TYPO_COLLEE ? CONSIGNE_PONCTUATION : "",
      ].filter(Boolean).join("\n");
      const sessionInstructions = collerPonctuation(contexte ? `${instructionsBase}\n\n# Contexte de cet appel\n${contexte}` : instructionsBase);
      // Le transfert n'est offert que si l'appel peut vraiment basculer : un numero lisible et les
      // identifiants Twilio du numero appele. Il remplace alors request_handoff de Dale Voz, qui ne
      // fait qu'ouvrir une demande dans la messagerie : au telephone, le client attendrait pour rien.
      const transfertPossible = Boolean(TRANSFERT_NUMERO && canalDV?.accountSid && canalDV?.authToken);
      const outilsDV = (sessionDV?.tools ?? []).filter((t) => !(transfertPossible && t.name === "request_handoff"));
      const outils = [
        ...(profilLocal ? pizzeria.tools : []),
        ...(transfertPossible ? [outilTransfert(TRANSFERT_NOM)] : []),
        ...outilsDV,
      ];
      // LA REFLEXION VIENT DE L'AGENT (16/09/2026). `grok-voice-latest` est un alias de think-fast-2.0,
      // qui reflechit avant de parler, et la doc xAI met `reasoning.effort` a "high" par defaut. Le pont
      // envoyait toujours GROK_REASONING (defaut "high") : un agent regle sur « Rapide » dans l'onglet
      // Voix (Palazzo) reflechissait quand meme avant chaque reponse, d'ou la latence remontee par Jacky.
      const effort = sessionDV?.reasoning === "none" || sessionDV?.reasoning === "high" ? sessionDV.reasoning : GROK_REASONING;
      console.log(`[session] modele=${modele} reflexion=${effort} tours=${TOURS_PAR_LE_PONT ? "pont fin_de_tour=" + finDeTourMs + "ms" : "grok seuil=" + seuilVad} vitesse=${vitesse} coupure=${bargeIn ? "oui" : "non"} carte=${carteAjoutee ? "ajoutee" : "non"} anticipation=${ANTICIPATION_MS}ms doublure=${HEDGE_APRES_MS ? HEDGE_APRES_MS + "ms" : "non"} ambiance=${AMBIANCE_APRES_MS ? AMBIANCE_APRES_MS + "ms" : "non"} fin_de_tour=${eot ? "modele seuil=" + EOT_SEUIL + " delai=" + EOT_DELAI_MS + "ms filet=" + finDeTourMs + "ms" : "silence seul"} ${t()} sid=${callSid}`);
      grok.send(JSON.stringify({
        type: "session.update",
        session: {
          instructions: sessionInstructions,
          ...(outils.length ? { tools: outils, tool_choice: "auto" } : {}),
          voice: sessionDV?.voice || GROK_VOICE,
          reasoning: { effort },
          ...(TOURS_PAR_LE_PONT ? {} : { turn_detection: { type: "server_vad", threshold: seuilVad, prefix_padding_ms: 300, silence_duration_ms: 600 } }),
          input_audio_transcription: { language: AGENT_LANG }, // ancien schema, ignore en silence par xAI : garde pour compatibilite
          audio: {
            input: {
              format: { type: "audio/pcm", rate: GROK_RATE },
              transcription: { model: "grok-transcribe", language_hint: AGENT_LANG },
              ...(TOURS_PAR_LE_PONT ? { turn_detection: null } : {}),
            },
            output: { format: { type: "audio/pcm", rate: GROK_RATE }, speed: vitesse },
          },
        },
      }));
      // La doublure joue la MEME session, moins ce qui ne la concerne pas : elle n'entend jamais le client,
      // son historique lui arrive en texte. Elle garde les outils pour savoir qu'un tour en demande un : dans
      // ce cas on la jette et on attend la primaire, qui seule sait derouler le cycle.
      if (TOURS_PAR_LE_PONT && HEDGE_APRES_MS > 0) ouvrirDoublure({ modele, vitesse, effort, sessionInstructions, outils });
    });

    grok.on("message", (raw) => {
      let e;
      try { e = JSON.parse(raw.toString()); } catch { return; }
      switch (e.type) {
        case "ping":
          grok.send(JSON.stringify({ type: "pong", ...(e.event_id ? { event_id: e.event_id } : {}) }));
          break;
        case "session.updated":
          if (!grokReady) {
            grokReady = true;
            // L'accueil de la porte Telephone (Format et Accueil de Dale Voz) se dit MOT POUR MOT au premier tour.
            // Laisse au modele, il perdait contre un prompt qui imposait sa propre premiere phrase.
            const accueil = typeof sessionDV?.greeting === "string" ? sessionDV.greeting.trim() : "";
            if (TOURS_PAR_LE_PONT) marquerGeneration();
            grok.send(JSON.stringify(accueil
              ? { type: "response.create", response: { instructions: `Dis exactement cette phrase, mot pour mot, sans rien ajouter avant ni apres, avec le sourire et beaucoup d'entrain, comme une Italienne ravie d'accueillir, puis ecoute : « ${collerPonctuation(accueil)} »` } }
              : { type: "response.create" }));
          } // salut une fois
          break;
        case "response.created":
          if (TOURS_PAR_LE_PONT) { marquerGeneration(); reponseActive = true; }
          attenteCreation = false;
          if (anticipation) anticipation.etat = "creee";
          attenteSuite = null;
          reponseApresOutil = relanceOutilDemandee;
          relanceOutilDemandee = false;
          resteAudio = Buffer.alloc(0);
          audioReponseOctets = 0; debutReponseMs = Date.now(); premierSon = false;
          rediteTranchee = false; retenueRedite = []; retenueDepuis = 0;
          // Nouvelle reponse : la doublure repart de zero, et ce qu'elle produisait encore n'a plus d'objet.
          doublureGagnante = false; resteAudioDoublure = Buffer.alloc(0);
          if (doublure?.occupee) doublure.abandonner("nouvelle reponse de la primaire");
          pushUser(); // le tour du client est fini, l'agent repond
          respSeq++;
          agentSpeaking = true; agentSpeakingSince = Date.now(); // Dany commence a parler -> on coupe l'ecoute (anti-echo)
          if (reponseAnticipee === -1) reponseAnticipee = respSeq;
          console.log(`[turn] Dany n°${respSeq}${anticipation || reponseAnticipee === respSeq ? " (anticipee)" : ""} ${t()}`);
          break;
        case "response.function_call_arguments.done":
          pendingCalls.push({ name: e.name, callId: e.call_id, args: e.arguments });
          break;
        case "response.output_audio.delta": {
          if (!e.delta || !streamSid || twilio.readyState !== WebSocket.OPEN) break;
          // Reponse coupee par le client : xAI ne sait pas annuler une reponse (response.cancel est
          // « Unsupported » dans sa doc), donc la suite qu'il genere encore est jetee ici.
          if (respSeq === reponseCoupee) break;
          if (respSeq === primaireJetee) break; // la doublure joue ce tour a sa place
          if (DOUBLURE_TEST_MS && doublure && Date.now() - debutReponseMs < DOUBLURE_TEST_MS) break; // banc
          const brut = Buffer.concat([resteAudio, Buffer.from(e.delta, "base64")]);
          const pair = brut.length - (brut.length % 2);
          resteAudio = Buffer.from(brut.subarray(pair)); // 0 ou 1 octet
          if (pair === 0) break;
          const pcm = Buffer.from(brut.subarray(0, pair)); // copie : offset pair, sinon Int16Array leve
          const ulaw = pcm16ToUlaw8k(pcm, GROK_RATE);
          if (ulaw.length === 0) { mediasVides++; break; }
          if (anticipation) { // la fin du tour n'est pas confirmee : le son attend
            if (!anticipation.annulee) { if (!anticipation.pretA) anticipation.pretA = Date.now(); anticipation.audio.push(ulaw); }
            break;
          }
          envoyerSonAgent(ulaw);
          break;
        }
        case "response.output_audio_transcript.delta":
          if (e.delta) { agentBuf += e.delta; if (CLOSING_RE.test(agentBuf)) closingSaid = true; }
          break;
        case "response.done": {
          if (anticipation) {
            // Reponse anticipee : annulee, elle s'efface ; finie avant la fin du tour, tout attend la confirmation.
            if (anticipation.annulee) finirAnnulation(e);
            else { anticipation.etat = "finie"; anticipation.fin = e; reponseActive = false; }
            break;
          }
          if (e.response?.status === "cancelled") { // le pont n'annule qu'une anticipation : reliquat d'une annulation deja soldee
            console.log(`[reponse] n°${respSeq} statut=cancelled (reliquat) ${t()} sid=${callSid}`);
            reponseActive = false; generation = false; pendingCalls = []; agentBuf = "";
            lacherRetenue();
            break;
          }
          terminerReponse(e);
          break;
        }
        case "conversation.item.input_audio_transcription.updated":
        case "conversation.item.input_audio_transcription.completed":
          if (process.env.JOURNAL_DIALOGUE === "1") console.log(`[transcription] ${e.type.split(".").pop()} item=${e.item_id} ligne=${tourClient ? tourClient.idx : "aucune"} « ${e.transcript} » ${t()}`);
          noterEntreeClient(e.item_id, e.transcript);
          setUser(e.transcript, false); // cumulatif ou final : remplace
          break;
        case "conversation.item.input_audio_transcription.delta":
          noterEntreeClient(e.item_id, e.delta);
          setUser(e.delta, true);
          break;
        case "conversation.item.added":
          if (e.item?.id) itemsAjoutes.add(e.item.id);
          // Ce que la reponse anticipee ajoute (message, appels d'outil) s'effacera avec elle si elle est annulee.
          if (anticipation && anticipation.etat !== "demandee" && e.item?.id && e.item.role !== "user") anticipation.items.push(e.item.id);
          if (!typesVus.has(e.type)) { typesVus.add(e.type); console.log(`[grok] ${e.type}${e.item?.type ? " " + e.item.type : ""} ${t()}`); }
          break;
        case "conversation.item.deleted":
          suppressionsEnCours = Math.max(0, suppressionsEnCours - 1);
          console.log(`[grok] ${e.type} ${t()}`);
          break;
        case "input_audio_buffer.speech_started": {
          if (TOURS_PAR_LE_PONT) break; // en mode manuel, Grok signale encore la parole : le pont a deja decide
          tourClient = { idx: null };
          if (recapTs) clientApresRecap = true;
          lastCallerMs = Date.now();
          relancesOutils = 0;
          checkedIn = false; // le client reparle : on reinitialise la detection de silence
          finParoleClientMs = 0;
          // COUPURE SUR VRAIE PRISE DE PAROLE (16/09/2026). Jacky : « des fins de phrase coupees ». Chaque debut
          // de parole detecte videait tout de suite la file Twilio : un « mmm », un souffle ou un « oui »
          // d'acquiescement coupait la fin de la phrase de l'agent. La decision se prend dans verifierCoupure,
          // sur la voix mesuree par le pont. Jamais pendant l'accueil : il annonce l'IA.
          parleSelonGrok = true;
          entenduSurAgent = false; coupeCeTour = false; voixMaxTour = 0;
          console.log(`[turn] client ${t()} voix_pont=${Math.round(voixRecenteMs)}ms${e.audio_start_ms != null ? ` debut_audio=${e.audio_start_ms} pos=${Math.round(audioEnvoyeMs)}` : ""}`);
          verifierCoupure();
          break;
        }
        case "input_audio_buffer.speech_stopped":
          if (TOURS_PAR_LE_PONT) break;
          finParoleClientMs = Date.now();
          parleSelonGrok = false;
          console.log(`[turn] client se tait ${t()}${e.audio_end_ms != null ? ` fin_audio=${e.audio_end_ms} pos=${Math.round(audioEnvoyeMs)}` : ""}`);
          if (entenduSurAgent && !coupeCeTour) console.log(`[turn] son bref ignore (${Math.round(voixMaxTour)} ms de voix), l'agent finit sa phrase sid=${callSid}`);
          break;
        case "error":
          // Ignorees en silence jusqu'au 16/09/2026 : une erreur de Grok ne laissait aucune trace.
          console.error(`[grok] erreur ${JSON.stringify(e.error || e).slice(0, 300)} ${t()} sid=${callSid}`);
          // Un effacement refuse (anticipation annulee) n'est pas un refus de reponse : rien a relacher.
          if (suppressionsEnCours > 0 && /item/i.test(JSON.stringify(e.error || e))) { suppressionsEnCours--; break; }
          // Une demande de reponse refusee ne doit pas laisser la voix du client retenue pour toujours.
          if (TOURS_PAR_LE_PONT && generation && !reponseActive && !anticipation) { generation = false; attenteCreation = false; lacherRetenue(); }
          break;
        default:
          // Tout le reste une fois par appel, sauf ce qui peut expliquer une reponse perdue (annulation,
          // remplacement, tampon valide), journalise a chaque fois : l'essai du 16/09 a vu une reponse creee
          // disparaitre sans response.done, et rien ne disait pourquoi.
          if (/cancel|truncat|interrupt|commit|clear|fail|incomplete|delete/i.test(e.type) || !typesVus.has(e.type)) {
            typesVus.add(e.type);
            console.log(`[grok] ${e.type}${e.response?.id ? " " + e.response.id : ""}${e.item?.type ? " " + e.item.type : ""} ${t()}`);
          }
          break;
      }
    });

    grok.on("close", (code, raison) => {
      if (!finalized) console.error(`[grok] ws fermee en cours d'appel code=${code} ${String(raison || "").slice(0, 120)} sid=${callSid}`);
    });
    grok.on("error", (err) => console.error("[grok] ws error", err.message));
  }

  // RTT reel entre le pont et le Media Engine de Twilio, par ping WebSocket natif. C'est la SEULE mesure
  // possible de ce saut : Voice Insights ne donne le poste reseau que pour ConversationRelay, jamais pour Media
  // Streams. Elle dit si le pont est bien place : nos numeros sont traites en `us1` (Virginie), donc un pont
  // europeen fait traverser l'Atlantique a l'audio deux fois de plus par tour. Cinq pings au debut de l'appel,
  // la mediane au journal, rien d'autre : aucune incidence sur la conversation.
  function mesurerRttTwilio() {
    const mesures = [];
    let n = 0;
    const tic = setInterval(() => {
      if (finalized || twilio.readyState !== WebSocket.OPEN || n >= 5) {
        clearInterval(tic);
        if (mesures.length) {
          const tri = mesures.slice().sort((a, b) => a - b);
          console.log(`[reseau] rtt twilio mediane ${tri[tri.length >> 1]} ms (${mesures.map(Math.round).join(", ")}) sid=${callSid}`);
        }
        return;
      }
      n++;
      const t0 = Date.now();
      try { twilio.ping(); } catch { clearInterval(tic); return; }
      twilio.once("pong", () => mesures.push(Date.now() - t0));
    }, 1500);
  }
  twilio.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.event === "start") {
      streamSid = m.start.streamSid;
      callSid = m.start.callSid;
      fromNumber = (m.start.customParameters && (m.start.customParameters.from || m.start.customParameters.From)) || null;
      toNumber = (m.start.customParameters && (m.start.customParameters.to || m.start.customParameters.To)) || null;
      console.log(`[call] start sid=${callSid} from=${fromNumber} to=${toNumber}`);
      mesurerRttTwilio();
      openGrok();
    } else if (m.event === "media") {
      // Filet si le mark "agentdone" se perd : jamais tant que l'audio envoye n'a pas fini de jouer (une longue
      // reponse depasse AGENT_SPEAKING_MAX_MS), et le silence repart de la fin de lecture.
      if (agentSpeaking && Date.now() - agentSpeakingSince > AGENT_SPEAKING_MAX_MS && Date.now() > finLecture + 2000) { agentSpeaking = false; lastCallerMs = Math.max(Date.now(), finLecture); }
      // BARGE_IN=1 : la voix du client part TOUJOURS a Grok, meme pendant que l'agent parle,
      // et un debut de parole coupe la reponse en cours. Sans lui (Motralec), le demi-duplex
      // reste : on n'ecoute pas tant que Twilio n'a pas fini de lire, et le client ne peut
      // pas interrompre. Constate le 16/09/2026 sur Palazzo : l'agent lit la carte et
      // relance apres chaque outil, le client reste sourd jusqu'a 25 s et n'arrive pas a
      // l'arreter. L'echo qui avait motive le demi-duplex venait d'un haut-parleur ; un
      // combine n'en produit pas, et une fausse coupure coute moins qu'un agent qu'on ne
      // peut pas faire taire.
      // Une fois l'annonce du transfert partie, plus rien ne va a Grok : le client parle deja a l'humain.
      if (transfert && transfert.etat !== "annonce") return;
      const pcm = ulaw8kToPcm16(Buffer.from(m.media.payload, "base64"), GROK_RATE);
      // Le modele de fin de tour voit TOUT l'appel, sans trou : il juge la prosodie des secondes qui precedent
      // la pause, pas la pause elle-meme. Le decoupage par tour se fait au moment de l'interroger, pas ici.
      eot?.pousser(pcm);
      const rms = rmsPcm16(pcm);
      const niveau = rms < 150 ? 0 : rms < 300 ? 1 : rms < 600 ? 2 : rms < 1200 ? 3 : rms < 2400 ? 4 : 5;
      sonHisto[niveau]++;
      if (Date.now() < finLecture) sonHistoAgent[niveau]++;
      const paquetMs = (pcm.length / 2 / GROK_RATE) * 1000;
      const maintenant = Date.now();
      if (TOURS_PAR_LE_PONT) {
        // Seuil de voix adapte a la ligne : deux fois le plancher de bruit des 5 dernieres secondes, borne entre
        // SEUIL_SON_RMS et 1200 (une voix basse au telephone reste au-dessus).
        niveaux[niveauxIdx] = rms;
        niveauxIdx = (niveauxIdx + 1) % niveaux.length;
        if (niveauxN < niveaux.length) niveauxN++;
        if (maintenant - seuilCalculeA > 500 && niveauxN >= 50) {
          const tri = Array.from(niveaux.subarray(0, niveauxN)).sort((x, y) => x - y);
          seuilVoix = Math.min(1200, Math.max(SEUIL_SON_RMS, tri[Math.floor(niveauxN * 0.1)] * 2));
          if (seuilVoix > seuilMax) seuilMax = seuilVoix;
          seuilCalculeA = maintenant;
        }
      }
      const voix = rms >= (TOURS_PAR_LE_PONT ? seuilVoix : SEUIL_SON_RMS);
      const voixMs = voix ? paquetMs : 0;
      voixRecenteMs += voixMs - voixFenetre[voixFenetreIdx];
      voixFenetre[voixFenetreIdx] = voixMs;
      voixFenetreIdx = (voixFenetreIdx + 1) % voixFenetre.length;
      if (TOURS_PAR_LE_PONT) {
        if (attenteCreation && maintenant - creationDemandeeA > REPONSE_IGNOREE_MS) reponseIgnoree();
        if (attenteDepuis && MMM_APRES_MS > 0 && !tour && !transfert && !endRequested && maintenant - attenteDepuis >= MMM_APRES_MS
          && maintenant >= finLecture && (generation || outilsEnCours || tourEnAttente)
          && !(reponseActive && maintenant - debutReponseMs < MMM_CREEE_DEPUIS_MS) // son imminent : pas de « Mmm » devant
          && !(generation && !reponseActive && maintenant - generationDemandeeA < 400)) jouerMmm(maintenant); // relance tout juste demandee
        // Ambiance de salle (voir AMBIANCE_APRES_MS) : meme blanc que le « Mmm », mais tant qu'il dure, et sans
        // aucune des gardes qui protegent la vraie reponse (elle passe devant, ce fond ne retarde rien).
        if (ambianceBoucle && attenteDepuis && !tour && !transfert && !endRequested
          && maintenant - attenteDepuis >= AMBIANCE_APRES_MS && maintenant >= finLecture
          && (generation || outilsEnCours || tourEnAttente)) jouerAmbiance(maintenant, Math.round(paquetMs * 8));
        else arreterAmbiance(maintenant);
        // Doublure (voir HEDGE_APRES_MS) : une reponse CREEE, muette depuis plus de HEDGE_APRES_MS, est un vrai
        // blocage de Grok (une reponse normale parle 0,6 a 1,4 s apres sa creation). On demande la meme reponse
        // a la seconde session et on jouera celle qui parle. Jamais pendant un cycle d'outils : la doublure ne
        // sait pas les executer, et la relance qui suit un outil est simplement lente, pas bloquee.
        if (doublure && !doublureGagnante && reponseActive && !outilsEnCours && !tour && !transfert && !endRequested
          && !premierSon && audioReponseOctets === 0 && doublureTour !== respSeq
          && maintenant - debutReponseMs >= HEDGE_APRES_MS) demanderDoublure(maintenant);
        // Filet : si la doublure ne rend jamais son `response.done` (ws morte), la generation resterait ouverte
        // et le pont sourd. Au-dela de TOUR_MAX_MS on rend la main a la primaire, quoi qu'il arrive.
        if (doublureGagnante && maintenant - debutReponseMs > TOUR_MAX_MS) {
          console.log(`[doublure] silencieuse depuis ${maintenant - debutReponseMs} ms : on rend la main ${t()} sid=${callSid}`);
          doublureGagnante = false; generation = false; lacherRetenue();
        }
        // Seules les prises de parole partent a Grok (300 ms avant, 600 ms de silence apres) : son tampon ne
        // contient que ce que le client a dit, et un son ignore s'efface sans rien laisser.
        if (voix) {
          if (!tour) {
            tour = { debut: maintenant, voixMs: 0, derniereVoix: maintenant, coupe: false };
            lastCallerMs = maintenant;
            attenteSuite = null;
            // Le client reprend la parole : ce que la doublure produisait repondait a l'etat d'avant.
            if (!doublureGagnante && doublure?.occupee) doublure.abandonner("le client reprend la parole");
            // Les transcriptions en direct de cette prise de parole ne doivent pas reecrire la ligne du tour precedent.
            if (tourClient && tourClient.idx != null) tourClient = null;
            envoyerAGrok(preroll.splice(0));
          }
          tour.voixMs += paquetMs;
          tour.derniereVoix = maintenant;
          if (anticipation && anticipation.tour === tour && !anticipation.annulee && (anticipation.voixDepuis += paquetMs) >= ANNULATION_VOIX_MS) {
            annulerAnticipation(`le client reprend (${Math.round(anticipation.voixDepuis)} ms de voix)`);
          }
        }
        if (tour) {
          envoyerAGrok([pcm]);
          verifierCoupure();
          if (tour && !voix && peutAnticiper(maintenant)) lancerAnticipation();
          // Fin de tour par modele (voir EOT_MODELE). Il REMPLACE le comptage de silence, qui ne reste qu'en
          // filet : des EOT_DELAI_MS de silence on interroge le modele, et sa reponse ne vaut que si le client
          // n'a pas reparle depuis l'instant ou on la lui a demandee (il n'a vu que l'audio d'alors).
          if (eot && tour && !voix && maintenant - tour.derniereVoix >= EOT_DELAI_MS) eot.demander(maintenant);
          if (eot && tour) {
            const v = eot.prendreVerdict();
            if (v && v.p >= EOT_SEUIL && v.demandeA > tour.derniereVoix) {
              eotFini++;
              const silence = Math.round(maintenant - tour.derniereVoix);
              console.log(`[eot] fini a ${(v.p).toFixed(3)} apres ${Math.round(v.demandeA - tour.derniereVoix)} ms de silence, verdict rendu en ${Math.round(v.ms)} ms, ${Math.round(finDeTourMs - silence)} ms avant le filet ${t()} sid=${callSid}`);
              finDuTour();
            }
          }
          if (tour && ((!voix && maintenant - tour.derniereVoix >= finDeTourMs) || maintenant - tour.debut > TOUR_MAX_MS)) finDuTour();
        } else {
          preroll.push(pcm);
          if (preroll.length > PREROLL_PAQUETS) preroll.shift();
          if (attenteSuite && !generation && !outilsEnCours && !tourEnAttente && !endRequested && !transfert
            && maintenant > Math.max(finLecture, lastCallerMs) + RELANCE_SUITE_MS) {
            attenteSuite = null;
            relanceSuiteFaite = true;
            console.log(`[tour] le client attend la suite, l'agent enchaine ${t()}`);
            promptGrok("(SYSTÈME : ta dernière phrase ne posait pas de question et le client attend. Enchaîne tout de suite sur l'étape suivante, en une phrase courte qui pose une question, suivie de deux ou trois mots comme « Je vous écoute. ».)");
          }
        }
      } else {
        verifierCoupure();
        if (grok && grok.readyState === WebSocket.OPEN && grokReady && (bargeIn || !agentSpeaking)) {
          grok.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
          audioEnvoyeMs += paquetMs;
        }
      }
    } else if (m.event === "mark") {
      if (m.mark && m.mark.name === "hangup") { try { twilio.close(); } catch {} }
      else if (m.mark && m.mark.name === "transfert") lancerTransfert("fin de l'annonce");
      else if (m.mark && /^agentdone(:|$)/.test(m.mark.name) && (m.mark.name === "agentdone" || Number(m.mark.name.split(":")[1]) === respSeq)) { agentSpeaking = false; lastCallerMs = Date.now(); console.log(`[turn] lecture finie ${m.mark.name} ${t()} sid=${callSid}`); } // Dany a fini de parler (audio joue) : on rouvre l'ecoute + on relance le compte a rebours du silence. Le mark d'une reponse anterieure (outil suivi d'une relance) est ignore.
    } else if (m.event === "stop") {
      finalize();
    }
  });
  twilio.on("close", (code, raison) => {
    console.log(`[twilio] flux ferme code=${code} ${String(raison || "").slice(0, 120)} medias_vides_evites=${mediasVides} sid=${callSid}`);
    finalize();
  });
  twilio.on("error", (err) => { console.error("[twilio] ws error", err.message); finalize(); });

  // Filet anti-credits : si le client se tait apres la cloture (8s) ou reste inactif longtemps (30s),
  // on raccroche, au cas ou l'agent n'aurait pas appele end_call.
  // Fait parler Dany via une instruction systeme injectee (check-in ou conge).
  function promptGrok(text) {
    try {
      grok.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: collerPonctuation(text) }] } }));
      entreeNouvelle = true; // la consigne EST l'entree a laquelle repondre
      if (TOURS_PAR_LE_PONT) marquerGeneration();
      grok.send(JSON.stringify({ type: "response.create" }));
    } catch {}
  }

  // Outils : un appel d'outil termine la reponse du modele. On renvoie le resultat PUIS on relance,
  // sinon il reste muet. Plafond de relances par tour client, sinon il s'enchaine tout seul.
  const outilLocal = (nom) => Boolean(pizzeria) && !commandesParDaleVoz() && pizzeria.tools.some((t) => t.name === nom);

  // Pendant les outils, une prise de parole qui se termine attend la relance au lieu de demander sa propre
  // reponse : deux response.create se croiseraient.
  async function runTools(calls) {
    outilsEnCours = true;
    try { return await executerOutils(calls); } finally { outilsEnCours = false; }
  }
  async function executerOutils(calls) {
    if (!(grok && grok.readyState === WebSocket.OPEN)) return;
    const audioDeLaReponse = audioReponseOctets; // ce que la reponse qui appelle ces outils a deja dit
    let raccroche = false;
    for (const c of calls) {
      let args = {};
      try { args = JSON.parse(c.args || "{}"); } catch {}
      // Commande modifiee : un nouveau recapitulatif est exige, quel que soit l'executant de l'outil.
      if (c.name === "chiffrer_commande") { recapTs = 0; clientApresRecap = false; }
      let out;
      if (c.name === "end_call" && messageTransmisSansReponse) {
        // GARDE (17/09/2026, repetition de demo) : « Lorenzo vous rappellera… », end_call dans la meme reponse, et le
        // client raccroche au nez sans avoir pu donner son prenom. Apres un message transmis, on ne raccroche pas tant
        // que le client n'a pas repondu. Refuse une fois : si l'agent insiste, le second essai passe.
        messageTransmisSansReponse = false;
        out = { ok: false, erreur: "raccrochage refusé", consigne: "Ne raccroche pas maintenant : tu viens de transmettre un message et le client n'a pas encore répondu. Demande-lui en une phrase courte s'il y a autre chose pour lui, puis attends sa réponse." };
        console.log(`[garde] raccrochage refuse juste apres un message transmis ${t()} sid=${callSid}`);
      } else if (c.name === "end_call") {
        // Outil de Dale Voz : cote web la surface raccroche, ici c'est Twilio.
        out = { ok: true };
        raccroche = true;
        setTimeout(() => requestHangup("end_call"), 1500);
      } else if (c.name === "transferer_appel") {
        const qui = TRANSFERT_NOM || "quelqu'un de l'équipe";
        if (!(TRANSFERT_NUMERO && canalDV?.accountSid && canalDV?.authToken && callSid)) {
          out = { ok: false, erreur: "transfert indisponible", consigne: "Le transfert n'est pas possible pour le moment : dis-le simplement et propose de transmettre un message pour que l'équipe rappelle." };
        } else if (transfert) {
          out = { ok: true, deja_en_cours: true, consigne: "Le transfert est déjà en cours : ne dis plus rien." };
        } else {
          transfert = { etat: "annonce", motif: String(args.motif || "").slice(0, 200), filet: null };
          // Filet : si la phrase d'annonce ne vient jamais (relance plafonnee, reponse perdue), on bascule quand meme.
          transfert.filet = setTimeout(() => lancerTransfert("filet"), 12000);
          out = { ok: true, consigne: `Le transfert vers ${qui} est lancé. Si tu n'as pas déjà prévenu le client, dis seulement : « Je vous passe ${qui}, ne quittez pas. » Sinon, ne dis rien. Ensuite, plus un mot.` };
        }
      } else if (outilLocal(c.name)) {
        try {
          out = await pizzeria.runAsync(c.name, args, {
            callSid,
            from: frPhone(fromNumber),
            recapConfirme: recapTs > 0 && clientApresRecap,
            dv: canalDV ? { tenantId: canalDV.tenantId, agentSlug: canalDV.agentSlug } : null,
          });
        }
        catch (err) { out = { ok: false, erreur: err.message }; console.error(`[outil] ${c.name} KO`, err); }
      } else if (canalDV) {
        const commande = OUTILS_DE_COMMANDE.has(c.name);
        if (commande && c.name === "enregistrer_commande") console.log(`[outil] enregistrer_commande : replique envoyee ${repliqueAvantClient ? `(${repliqueAvantClient.length} car) « …${repliqueAvantClient.slice(-160)} »` : "aucune"} ${t()}`);
        const reponse = await executerOutil({
          tenantId: canalDV.tenantId,
          agentSlug: canalDV.agentSlug,
          outil: c.name,
          args,
          sessionId: sessionIdDV,
          locale: canalDV.locale,
          ...(commande ? { appel: { id: callSid, telephone: frPhone(fromNumber), recapConfirme: recapTs > 0 && clientApresRecap, ...(repliqueAvantClient ? { replique: repliqueAvantClient.slice(-2000) } : {}) } } : {}),
        });
        // La plateforme renvoie { output } deja serialise ; null = elle n'a pas repondu.
        out = reponse?.output ?? { ok: false, erreur: "outil indisponible" };
        if (c.name === "enregistrer_commande" && typeof out === "string" && /"ok":\s*true/.test(out)) commandeEnregistreeDV = true;
      } else {
        out = { ok: false, erreur: `outil inconnu ${c.name}` };
      }
      if (c.name === "transmettre_message") messageTransmisSansReponse = true;
      const sortie = typeof out === "string" ? out : JSON.stringify(out);
      console.log(`[outil] ${c.name} ${JSON.stringify(args)} -> ${sortie.slice(0, 300)} ${t()}`);
      dialog.push({ who: "Outil", msg: `${c.name} ${JSON.stringify(args)} -> ${sortie}` });
      if (!(grok && grok.readyState === WebSocket.OPEN)) return;
      // Le recapitulatif et les consignes rendus par les outils sont repris tels quels par le modele : meme typographie.
      grok.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: c.callId, output: collerPonctuation(sortie) } }));
      entreeNouvelle = true; // le resultat de l'outil EST l'entree a laquelle la relance repond
    }
    // Ce que le client a dit pendant la reponse ou les outils entre dans la conversation avant la relance.
    const tourPendant = TOURS_PAR_LE_PONT && tourEnAttente && !tour;
    if (tourPendant) validerTour();
    // L'au revoir est deja dit dans la reponse qui raccroche : la relancer faisait partir un second « À tout à
    // l'heure ! » pendant le raccrochage (repetition de demo du 17/09). Sans au revoir dit, la relance le fait dire.
    if (raccroche && audioDeLaReponse > 0 && calls.every((c) => c.name === "end_call")) {
      console.log(`[outil] end_call : pas de relance, l'au revoir est deja dit ${t()} sid=${callSid}`);
      return;
    }
    if (relancesOutils < MAX_RELANCES_OUTILS || tourPendant) {
      relancesOutils++;
      relanceOutilDemandee = true;
      if (TOURS_PAR_LE_PONT) marquerGeneration();
      rappelerFinDeQuestion();
      grok.send(JSON.stringify({ type: "response.create" }));
    } else {
      console.log(`[outil] plafond de relances atteint sid=${callSid}`);
      if (transfert && transfert.etat === "annonce") preparerTransfert(); // pas de phrase d'annonce a attendre
    }
  }

  // L'annonce est generee : on pose un mark derriere l'audio en file chez Twilio, qui le renvoie
  // quand tout a ete joue. Le filet repart de la fin de lecture estimee, pour le cas ou le mark se perd.
  function preparerTransfert() {
    if (!transfert || transfert.etat !== "annonce") return;
    transfert.etat = "attente";
    clearTimeout(transfert.filet);
    if (streamSid) { try { twilio.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "transfert" } })); } catch {} }
    transfert.filet = setTimeout(() => lancerTransfert("filet apres annonce"), Math.max(0, finLecture - Date.now()) + 4000);
  }

  // Bascule l'appel chez Twilio. Reussi, Twilio ferme le flux : finalize() ecrit l'appel dans Dale Voz
  // avec le motif de fin. Rate, l'agent reprend la parole et propose un message a transmettre.
  async function lancerTransfert(pourquoi) {
    if (!transfert || transfert.etat === "lance" || finalized) return;
    transfert.etat = "lance";
    clearTimeout(transfert.filet);
    const twiml = twimlTransfert({
      numero: TRANSFERT_NUMERO,
      callerId: toNumber,
      actionUrl: hotePont ? `https://${hotePont}/apres-transfert` : "",
    });
    const r = await basculerAppel({ accountSid: canalDV?.accountSid, authToken: canalDV?.authToken, callSid, twiml });
    if (r.ok) {
      endReason = `transfert vers ${TRANSFERT_NOM || "l'equipe"}`;
      dialog.push({ who: "Garde", msg: `appel transféré à ${TRANSFERT_NOM || "l'équipe"} (${pourquoi})${transfert.motif ? ", motif : " + transfert.motif : ""}` });
      console.log(`[transfert] appel bascule (${pourquoi}) sid=${callSid}`);
      return;
    }
    console.error(`[transfert] echec ${r.erreur} sid=${callSid}`);
    dialog.push({ who: "Garde", msg: `transfert échoué : ${r.erreur}` });
    transfert = null;
    if (grok && grok.readyState === WebSocket.OPEN) {
      promptGrok("(SYSTÈME : le transfert n'a pas pu se faire. Excuse-toi en une phrase courte, puis propose de transmettre un message pour que l'équipe rappelle le client.)");
    }
  }

  // Gestion du silence : 1) "vous etes toujours la ?" ; 2) si toujours silence, conge poli puis raccroche.
  const inactivityTimer = setInterval(() => {
    // Filet : une reponse demandee qui ne vient jamais (8 s) ou qui ne se termine jamais (30 s) ne doit pas
    // garder la voix du client retenue ; Grok a deja abandonne des reponses sans response.done.
    if (TOURS_PAR_LE_PONT && generation && !finalized && !anticipation) {
      const depuis = Date.now() - generationDemandeeA;
      if ((!reponseActive && depuis > 8000) || depuis > 30000) {
        console.log(`[tour] reponse jamais terminee (${Math.round(depuis / 1000)} s), la voix du client repart ${t()} sid=${callSid}`);
        generation = false; reponseActive = false; attenteCreation = false;
        lacherRetenue();
        if (tourEnAttente && !tour) { validerTour(); demanderReponse(); }
      }
    }
    // Filets de l'anticipation : un tour tenu ouvert par des bruits, ou une annulation jamais soldee par Grok.
    if (anticipation && !finalized) {
      if (!anticipation.annulee && Date.now() - anticipation.depuis > 10000) annulerAnticipation("plus de 10 s sans fin de tour");
      else if (anticipation.annulee && Date.now() - anticipation.annuleeA > 5000) finirAnnulation(null);
    }
    if (finalized || endRequested || transfert) return; // pendant un transfert, le silence n'est pas celui du client
    if (!(grok && grok.readyState === WebSocket.OPEN && grokReady)) return;
    if (TOURS_PAR_LE_PONT && (generation || tour || tourEnAttente || outilsEnCours)) return; // l'appel n'est pas silencieux
    // Lea parle encore (reponse en cours ou audio encore en file chez Twilio) : ce n'est pas un silence du client.
    if (Date.now() < finLecture || (agentSpeaking && Date.now() - agentSpeakingSince < AGENT_SPEAKING_MAX_MS)) return;
    const idle = Date.now() - Math.max(lastCallerMs, finLecture);
    if (closingSaid && idle > 8000) { requestHangup("cloture+silence"); return; }
    if (closeTriggered) { if (idle > 25000) requestHangup("inactivite"); return; } // conge en cours, backstop
    if (idle > 15000) {
      lastCallerMs = Date.now();
      if (!checkedIn) {
        checkedIn = true;
        promptGrok("(SYSTEME : le client est silencieux. Demande-lui brievement s'il est toujours la, par exemple 'Allo, vous etes toujours la ? Je vous ecoute.', et rien d'autre. Ne termine pas sur le point d'interrogation.)");
      } else {
        closeTriggered = true;
        promptGrok("(SYSTEME : le client ne repond toujours pas. Dis une breve phrase de conge polie qui remercie pour l'appel et souhaite une bonne journee, et rien d'autre.)");
      }
    }
  }, 2000);

  async function finalize() {
    if (finalized) return;
    finalized = true;
    clearInterval(inactivityTimer);
    pushUser();
    pushAgent();
    try { if (grok && grok.readyState === WebSocket.OPEN) grok.close(); } catch {}
    if (doublure) {
      console.log(`[doublure] ${doublureGagnees} reponse(s) jouee(s) sur ${doublureDemandees} demandee(s) sid=${callSid}`);
      doublure.fermer();
      doublure = null;
    }
    if (eot) {
      console.log(`[eot] ${eotFini} tour(s) conclu(s) par le modele sur ${toursValides} valides, ${eot.resume()} sid=${callSid}`);
      eot.fermer();
    }
    if (ambianceMs) console.log(`[ambiance] ${(ambianceMs / 1000).toFixed(1)} s de fond joues sur l'appel sid=${callSid}`);
    const lignes = dialog.filter((l) => String(l.msg || "").trim()); // une place reservee a une transcription jamais arrivee reste vide
    const text = lignes.map((l) => `${l.who} : ${l.msg}`).join("\n");
    console.log(`[call] stop sid=${callSid} lignes=${lignes.length}`);
    if (process.env.JOURNAL_DIALOGUE === "1") console.log(`[dialogue]\n${text}`); // bancs seulement : jamais en production
    // Niveaux de la voix du client sur tout l'appel (paquets de 20 ms) : ce qui sert a regler SEUIL_SON_RMS
    // d'apres de vraies lignes (bruit de fond d'un portable, d'une rue, d'une cuisine).
    console.log(`[son] rms <150:${sonHisto[0]} <300:${sonHisto[1]} <600:${sonHisto[2]} <1200:${sonHisto[3]} <2400:${sonHisto[4]} >=2400:${sonHisto[5]} pendant_agent=${sonHistoAgent.join("/")} seuil=${SEUIL_SON_RMS}${TOURS_PAR_LE_PONT ? ` seuil_max=${Math.round(seuilMax)} tours=${toursValides} ignores=${toursIgnores}` : ""} sid=${callSid}`);
    if (lignes.length) pushCall({ ts: new Date().toISOString(), from: fromNumber, sid: callSid, endReason, dialog: text });
    const hasClient = lignes.some((l) => l.who === "Client");

    // Dale Voz : l'appel entre dans Conversations et la minute est comptee.
    // Les lignes d'outil ne sont pas du dialogue, elles restent dans le journal du pont.
    if (canalDV) {
      const tours = lignes
        .filter((l) => l.who === "Client" || l.who === "Agent")
        .map((l) => ({ role: l.who === "Client" ? "user" : "assistant", text: l.msg }));
      const ecrit = await enregistrerAppel({
        tenantId: canalDV.tenantId,
        agentSlug: canalDV.agentSlug,
        turns: tours,
        appelId: callSid,
        dureeMs: Date.now() - debutAppelMs,
        userId: frPhone(fromNumber) || undefined,
        locale: canalDV.locale,
        diagnostic: endReason,
      });
      sessionIdDV = ecrit?.sessionId ?? null;
      console.log(`[dalevoz] appel ${sessionIdDV ? "ecrit " + sessionIdDV : "NON ecrit"} sid=${callSid}`);
    }
    if (hasClient && N8N_RECAP_URL) {
      const payload = { dialog: text, phone: fromNumber || "inconnu", call_sid: callSid };
      const ok = await postRecap(payload, 4); // essais immediats au raccrochage : 1s, 2s, 4s, 8s
      if (ok) console.log(`[recap] envoye a n8n sid=${callSid}`);
      else { pendingRecaps.push(payload); console.error(`[recap] n8n injoignable, mis en file de reessai sid=${callSid}`); }
    } else if (!hasClient) {
      console.log(`[call] raccroche sans parole, pas de recap sid=${callSid}`);
    }
  }
});

server.listen(PORT, () => console.log(`[boot] voice-reception-bridge sur :${PORT} (rate Grok ${GROK_RATE})`));
