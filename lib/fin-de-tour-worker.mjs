// Le modèle de fin de tour, dans son propre fil d'exécution.
//
// Il y est POUR UNE RAISON PRÉCISE : une inférence coûte ~103 ms sur un poste, dont ~35 ms de mel calculé en
// JavaScript pur, et ce mel-là bloque la boucle d'événements. Sur le fil principal, qui pompe un paquet Twilio
// toutes les 20 ms, ce serait deux paquets de retard à chaque décision, plusieurs fois par pause. Le fil
// séparé rend le coût invisible pour l'audio.
//
// Le fil garde son propre anneau de 8 secondes : le principal ne lui envoie que les 320 octets du paquet
// courant, jamais la fenêtre entière.
import { parentPort, workerData } from "node:worker_threads";
import { loadModel, predict } from "./smart-turn.mjs";
import { pcm8kVers16k, creerAnneau } from "./telephone-16k.js";

const anneau = creerAnneau(8);
let queue = null;
let session = null;
let occupe = false;

loadModel(workerData.modele, 1).then(
  (s) => { session = s; parentPort.postMessage({ t: "prete" }); },
  (e) => parentPort.postMessage({ t: "erreur", message: String(e?.message || e) }),
);

parentPort.on("message", async (m) => {
  if (m.t === "audio") {
    const r = pcm8kVers16k(Buffer.from(m.pcm), queue);
    queue = r.queue;
    anneau.pousser(r.pcm);
    return;
  }
  if (m.t === "score") {
    // Une seule inférence à la fois : le fil principal ne redemande pas tant qu'il n'a pas répondu, mais une
    // demande qui se croiserait avec la précédente attendrait pour rien.
    if (!session || occupe) { parentPort.postMessage({ t: "score", id: m.id, p: null }); return; }
    occupe = true;
    const debut = process.hrtime.bigint();
    try {
      const p = await predict(session, anneau.lire());
      parentPort.postMessage({ t: "score", id: m.id, p, ms: Number(process.hrtime.bigint() - debut) / 1e6 });
    } catch (e) {
      parentPort.postMessage({ t: "score", id: m.id, p: null, erreur: String(e?.message || e) });
    } finally {
      occupe = false;
    }
  }
});
