// Le moteur d'UN appel (07/11/2026). Le cerveau de l'oral se regle desormais PAR AGENT dans la console Dale Voz
// (trois crans : Economique = Grok Voice, Naturelle = ElevenLabs Realtime Max, Reactive = OpenAI Realtime 1.5 lu par
// une voix ElevenLabs). La console l'envoie dans /api/voice/session-config, champ `oral` :
//   { cran, famille: "grok" | "eleven-max" | "openai-realtime", modele, voix, lecture?: { voix } }
// `voix` a `null` (Eleven, OpenAI) = la voix ACTUELLE DE LA LIGNE : on garde celle du service (ELEVEN_REALTIME_VOIX,
// ELEVEN_VOIX). C'est ce qui garde Chiara chez Palazzo, un clone qui n'est pas au catalogue de la console.
// Absent (aucun cran choisi, ou agent sans Dale Voz) : le service garde son reglage `CERVEAU`, exactement comme avant.
//
// Replis, toujours vers Grok avec le timbre de l'agent, jamais un appel muet :
//   - credits ElevenLabs sous le seuil (solde lu par appel, voir soldeElevenAvecCache dans server.js), ou bascule
//     posee a la main (GARDE_BASCULE_LE) : Naturelle et Reactive passent en Grok ;
//   - cle manquante (ELEVENLABS_API_KEY, OPENAI_API_KEY) ;
//   - voix ou modele de mauvaise forme.
// Pur : teste par test/moteur-appel-test.mjs.

const VOIX_ELEVEN = /^[A-Za-z0-9]{20}$/;
/** Sous ce solde (caracteres ElevenLabs), un choix ElevenLabs de l'agent passe en Grok. GARDE_CREDITS_SEUIL le remplace. */
export const SEUIL_CREDITS_ELEVEN_DEFAUT = 5000;

/** Une voix acceptee : absente (= celle de la ligne) ou un identifiant ElevenLabs bien forme. */
const voixAcceptee = (v) => v === null || v === undefined || v === "" || VOIX_ELEVEN.test(String(v));
const voixOuLigne = (v) => (v === null || v === undefined || v === "" ? null : v);

/**
 * @param {object} p
 * @param {any} p.oral        le champ `oral` de la session Dale Voz (ou undefined)
 * @param {{ eleven: boolean, openai: boolean }} p.service  le moteur du service (CERVEAU)
 * @param {Record<string, string | undefined>} p.env
 * @param {number | null} [p.soldeEleven]  caracteres ElevenLabs restants, `null` si inconnu (alors pas de repli)
 * @returns {{ famille: "grok" | "eleven" | "openai", source: "agent" | "service", modele: string | null,
 *             voixEleven: string | null, voixLecture: string | null, raison: string | null }}
 */
export function moteurDeLAppel({ oral, service, env, soldeEleven = null }) {
  const duService = {
    famille: service.eleven ? "eleven" : service.openai ? "openai" : "grok",
    source: "service",
    modele: null,
    voixEleven: null,
    voixLecture: null,
    raison: null,
  };
  if (!oral || typeof oral !== "object") return duService;
  const grok = (raison) => ({
    famille: "grok",
    source: "agent",
    modele: typeof oral.modele === "string" && /^grok-voice/.test(oral.modele) && oral.famille === "grok" ? oral.modele : null,
    voixEleven: null,
    voixLecture: null,
    raison,
  });
  if (oral.famille === "grok") return grok(null);
  const seuil = Number(env.GARDE_CREDITS_SEUIL || SEUIL_CREDITS_ELEVEN_DEFAUT);
  const creditsBas = typeof soldeEleven === "number" && Number.isFinite(soldeEleven) && soldeEleven < seuil;
  const bascule = Boolean((env.GARDE_BASCULE_LE || "").trim());
  if (oral.famille === "eleven-max") {
    if (bascule) return grok("garde-fou des credits ElevenLabs declenche");
    if (creditsBas) return grok(`credits ElevenLabs bas (${soldeEleven} < ${seuil})`);
    if (!env.ELEVENLABS_API_KEY) return grok("ELEVENLABS_API_KEY absente");
    if (!voixAcceptee(oral.voix)) return grok(`voix ElevenLabs invalide (${String(oral.voix).slice(0, 24)})`);
    const modele = typeof oral.modele === "string" && /^eleven_realtime_/.test(oral.modele) ? oral.modele : null;
    return { famille: "eleven", source: "agent", modele, voixEleven: voixOuLigne(oral.voix), voixLecture: null, raison: null };
  }
  if (oral.famille === "openai-realtime") {
    const voixLecture = oral.lecture && "voix" in oral.lecture ? oral.lecture.voix : oral.voix;
    if (bascule) return grok("garde-fou des credits ElevenLabs declenche (la lecture est ElevenLabs)");
    if (creditsBas) return grok(`credits ElevenLabs bas (${soldeEleven} < ${seuil}), la lecture est ElevenLabs`);
    if (!env.OPENAI_API_KEY) return grok("OPENAI_API_KEY absente");
    if (!env.ELEVENLABS_API_KEY) return grok("ELEVENLABS_API_KEY absente (la lecture est ElevenLabs)");
    if (!voixAcceptee(voixLecture)) return grok(`voix de lecture invalide (${String(voixLecture).slice(0, 24)})`);
    const modele = typeof oral.modele === "string" && /^gpt-realtime/.test(oral.modele) ? oral.modele : "gpt-realtime-1.5";
    return { famille: "openai", source: "agent", modele, voixEleven: null, voixLecture: voixOuLigne(voixLecture), raison: null };
  }
  return duService; // famille inconnue : le service decide, comme sans reglage
}

/**
 * L'environnement de lecture ElevenLabs pour cet appel : celui du service, avec la voix de l'agent (ou, sans voix
 * choisie, celle de la ligne) et la langue de sa session. La balise de jeu (ELEVEN_BALISE) est propre a la voix du
 * service : une balise posee sur une autre voix a deja fait traduire la phrase (voir lecture-eleven.js), donc elle
 * tombe quand la voix change.
 */
export function envLectureDeLAppel(env, voix, langue = null) {
  const voixAppel = voix || env.ELEVEN_VOIX || env.ELEVEN_REALTIME_VOIX || "";
  const memeVoix = voixAppel === env.ELEVEN_VOIX;
  return {
    ...env,
    LECTURE: "elevenlabs",
    ELEVEN_VOIX: voixAppel,
    ...(memeVoix ? {} : { ELEVEN_BALISE: "" }),
    ...(langue ? { ELEVEN_LANGUE: langue } : {}),
  };
}
