// Décider qu'un client a fini de parler en ÉCOUTANT sa phrase, au lieu de compter le silence derrière.
//
// Le pont attend aujourd'hui `finDeTourMs` de silence sec (900 ms chez Palazzo). C'est le plus gros poste de
// latence qui reste, et c'est ce qui coupe la parole à quelqu'un qui hésite : mesuré sur 400 tours humains
// réels (corpus `livekit/eot-bench-data`, part française), le détecteur d'énergie coupe **17,6 % des
// hésitations** pour 685 ms d'attente moyenne. Smart Turn v3 regarde la forme d'onde, donc la PROSODIE :
// à attente égale il tombe à 10 % de coupures, soit 40 % d'interruptions en moins.
//
// ⚠ Le modèle REMPLACE le seuil de silence, il ne s'y empile pas (règle explicite de LiveKit) : `finDeTourMs`
// ne sert plus que de filet, pour les fins de tour que le modèle ne reconnaît pas. Il y en a 30 à 43 %, ce
// qui est normal et voulu : un modèle prudent coupe peu.
//
// Réglages (tous par variable d'environnement, `EOT_MODELE=0` coupe tout et rend le pont d'avant) :
//   EOT_MODELE      1 pour l'allumer. Coupé par défaut.
//   EOT_SEUIL       probabilité à partir de laquelle on conclut que le client a fini (0,98).
//   EOT_DELAI_MS    silence minimum avant la première question au modèle (500 ms).
//   EOT_CADENCE_MS  intervalle entre deux questions tant que le silence dure (100 ms).
//
// Le réglage 0,98 / 500 ms / filet 900 ms est le point mesuré au banc : 10 % de coupures, 697 ms d'attente
// moyenne. Les chiffres et le protocole sont dans `test/bancs/README.md` et dans le skill `agent-voice`,
// `references/telephony-reception.md` § 7 ter.
//
// ⚠ Ce que le banc ne comptait pas : l'inférence elle-même. Le verdict d'une question posée à 500 ms de
// silence arrive vers 600 ms. C'est de l'attente en plus, à retrancher du gain annoncé.
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const MODELE = path.join(ICI, "modeles", "smart-turn-v3.2-cpu.onnx");

/**
 * Un détecteur par appel. Le fil d'exécution met ~1 s à charger le modèle, ce qui passe inaperçu derrière
 * l'accueil ; tant qu'il n'est pas prêt, on ne demande rien et le filet fait le travail comme avant.
 *
 * @param {{ cadenceMs?: number, etiquette?: string, surErreur?: (m: string) => void }} options
 */
export function creerFinDeTour({ cadenceMs = 100, etiquette = "", surErreur } = {}) {
  const worker = new Worker(path.join(ICI, "fin-de-tour-worker.mjs"), { workerData: { modele: MODELE } });
  worker.unref(); // il ne doit jamais retenir le processus si un appel se termine mal
  let prete = false;
  let enVol = null;       // { id, demandeA } : une seule question à la fois
  let derniereA = 0;      // date de la dernière question posée
  let verdict = null;     // { p, demandeA, ms } pas encore lu par le pont
  let seq = 0;
  const stats = { questions: 0, msTotal: 0, msMax: 0 };

  worker.on("message", (m) => {
    if (m.t === "prete") { prete = true; return; }
    if (m.t === "erreur") { prete = false; surErreur?.(m.message); return; }
    if (m.t === "score") {
      const q = enVol;
      enVol = null;
      if (!q || q.id !== m.id || m.p == null) return;
      stats.questions++;
      stats.msTotal += m.ms || 0;
      if ((m.ms || 0) > stats.msMax) stats.msMax = m.ms;
      verdict = { p: m.p, demandeA: q.demandeA, ms: m.ms };
    }
  });
  worker.on("error", (e) => { prete = false; surErreur?.(String(e?.message || e)); });

  return {
    get prete() { return prete; },
    /** Le paquet du client, tel qu'il arrive de Twilio (PCM16 8 kHz). Le fil se charge du rééchantillonnage. */
    pousser(pcm) {
      if (!worker) return;
      worker.postMessage({ t: "audio", pcm: Buffer.from(pcm) }, []);
    },
    /** Pose la question si la cadence le permet et qu'aucune n'est déjà en vol. */
    demander(maintenant) {
      if (!prete || enVol || maintenant - derniereA < cadenceMs) return false;
      derniereA = maintenant;
      enVol = { id: ++seq, demandeA: maintenant };
      worker.postMessage({ t: "score", id: enVol.id });
      return true;
    },
    /**
     * Le dernier verdict non lu, et il ne se lit qu'une fois. L'appelant DOIT vérifier que le client n'a pas
     * reparlé depuis `demandeA` : le score ne vaut que pour l'audio que le modèle a vu à cet instant.
     */
    prendreVerdict() { const v = verdict; verdict = null; return v; },
    resume() {
      if (!stats.questions) return `${etiquette} aucune question posée`;
      return `${stats.questions} question(s), ${Math.round(stats.msTotal / stats.questions)} ms en moyenne, ${Math.round(stats.msMax)} ms au pire`;
    },
    fermer() { try { worker.terminate(); } catch {} },
  };
}
