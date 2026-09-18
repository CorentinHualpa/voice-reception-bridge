// La doublure seule (lib/doublure.js), sans Twilio ni pont : elle s'ouvre, recoit un historique en texte,
// repond, et ce qu'on lui a fait dire par la primaire n'est pas redit. Sert a verifier le module avant de le
// juger sur un appel complet, ou l'ordre des evenements rend tout diagnostic penible.
// Usage : node test/bancs/banc-doublure.mjs
import { AGENT, cle } from "./config-banc.mjs";
import { creerDoublure } from "../../lib/doublure.js";

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
let octets = 0, premierSonA = 0;

const d = creerDoublure({
  cle: cle("XAI_API_KEY"),
  modele: AGENT.model,
  etiquette: "banc",
  config: {
    instructions: AGENT.instructions,
    voice: AGENT.voice,
    reasoning: { effort: AGENT.reasoning },
    audio: {
      input: { format: { type: "audio/pcm", rate: 8000 }, turn_detection: null },
      output: { format: { type: "audio/pcm", rate: 8000 }, speed: AGENT.speed },
    },
  },
  sur: {
    son: (pcm) => { if (!premierSonA) premierSonA = Date.now(); octets += pcm.length; },
    outil: (nom) => console.log(`  outil demande : ${nom}`),
    finie: (statut, t) => console.log(`  finie (${statut}) : « ${t.texte.trim().slice(0, 200)} »`),
  },
});

console.log(`ouverture : ${(await d.ouvrir()) ? "ok" : "ECHEC"}`);
for (let i = 0; i < 60 && !d.prete; i++) await attendre(100);
console.log(`prete : ${d.prete}`);

// Historique pose en texte, comme le ferait le pont depuis `dialog`.
d.client("Bonjour, je vous appelle pour une pompe de relevage qui ne demarre plus.");
d.agent(AGENT.accueil);
d.client("Je suis a Vitry-sur-Seine.");
await attendre(600);

const t0 = Date.now();
console.log(`demande : ${d.demander(1)}`);
for (let i = 0; i < 200 && d.occupee; i++) await attendre(50);
console.log(`  premier son ${premierSonA ? premierSonA - t0 : "aucun"} ms, ${octets} octets`);

// Deuxieme tour : on lui fait dire une reponse qu'elle n'a pas produite, elle ne doit pas la redire.
d.agent("C'est note. Votre demande porte le numero 4712, un technicien vous rappelle avant 17h.");
d.client("Tres bien, merci.");
octets = 0; premierSonA = 0;
const t1 = Date.now();
console.log(`demande 2 : ${d.demander(2)}`);
for (let i = 0; i < 200 && d.occupee; i++) await attendre(50);
console.log(`  premier son ${premierSonA ? premierSonA - t1 : "aucun"} ms, ${octets} octets`);
d.fermer();
process.exit(0);
