// La doublure seule (lib/doublure.js), sans Twilio ni pont : elle s'ouvre, recoit un historique en texte,
// repond, et ce qu'on lui a fait dire par la primaire n'est pas redit. Sert a verifier le module avant de le
// juger sur un appel complet, ou l'ordre des evenements rend tout diagnostic penible.
// Usage : node test/bancs/banc-doublure.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { creerDoublure } from "../../lib/doublure.js";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const vault = fs.readFileSync(process.env.VAULT || "C:/Users/msi/.secrets/api-keys.env", "utf8");
const CLE = (vault.match(/^XAI_API_KEY=(.*)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
const session = JSON.parse(fs.readFileSync(path.join(ICI, "fixtures", "session-palazzo.json"), "utf8"));
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

let octets = 0, premierSonA = 0;
const d = creerDoublure({
  cle: CLE,
  modele: "grok-voice-latest",
  etiquette: "banc",
  config: {
    instructions: session.instructions,
    voice: session.voice || "eve",
    reasoning: { effort: "none" },
    audio: { input: { format: { type: "audio/pcm", rate: 8000 }, turn_detection: null }, output: { format: { type: "audio/pcm", rate: 8000 }, speed: session.speed || 1.1 } },
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
d.client("Bonjour, je voudrais commander.");
d.agent("Bonjour ! Avec plaisir. Qu'est-ce qui vous ferait plaisir ce soir ? Je vous ecoute.");
d.client("Deux Regina et une Veggie.");
await attendre(600);

const t0 = Date.now();
console.log(`demande : ${d.demander(1)}`);
for (let i = 0; i < 200 && d.occupee; i++) await attendre(50);
console.log(`  premier son ${premierSonA ? premierSonA - t0 : "aucun"} ms, ${octets} octets`);

// Deuxieme tour : on lui fait dire une reponse qu'elle n'a pas produite, elle ne doit pas la redire.
d.agent("Tres bien, deux Regina et une Veggie, cela fait quarante-cinq euros. C'est pour quel prenom? Dites-moi.");
d.client("Julien.");
octets = 0; premierSonA = 0;
const t1 = Date.now();
console.log(`demande 2 : ${d.demander(2)}`);
for (let i = 0; i < 200 && d.occupee; i++) await attendre(50);
console.log(`  premier son ${premierSonA ? premierSonA - t1 : "aucun"} ms, ${octets} octets`);
d.fermer();
process.exit(0);
