// Le pont vu depuis Dale Voz : à qui appartient le numéro appelé, quoi jouer,
// comment exécuter un outil de l'agent, et où écrire l'appel une fois fini.
//
// Le pont décroche pour PLUSIEURS clients : il ne s'authentifie donc pas avec une
// clé publishable (qui vaut pour un seul espace et se lit dans la page du client)
// mais avec un secret de serveur, `VOICE_BRIDGE_SECRET`, plus l'espace visé.
//
// Tout est facultatif : sans DALEVOZ_URL, le pont garde sa configuration locale
// (prompt en fichier, outils locaux). C'est ce qui fait tourner Palazzo et
// Motralec pendant que le canal se construit.

import crypto from "crypto";

const BASE = (process.env.DALEVOZ_URL || "").replace(/\/+$/, "");
const SECRET = process.env.VOICE_BRIDGE_SECRET || "";
const TIMEOUT_MS = Number(process.env.DALEVOZ_TIMEOUT_MS || 6000);

export const dalevozActif = Boolean(BASE && SECRET);

async function appeler(chemin, { methode = "GET", tenantId = null, corps = null, timeout = TIMEOUT_MS, rendreStatut = false } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(`${BASE}${chemin}`, {
      method: methode,
      headers: {
        "content-type": "application/json",
        "x-dalevoz-pont": SECRET,
        ...(tenantId ? { "x-dalevoz-tenant": tenantId } : {}),
      },
      ...(corps ? { body: JSON.stringify(corps) } : {}),
      signal: ctrl.signal,
    });
    const texte = await r.text();
    let json = null;
    try { json = texte ? JSON.parse(texte) : null; } catch {}
    if (!r.ok) console.error(`[dalevoz] ${methode} ${chemin} -> ${r.status} ${texte.slice(0, 200)}`);
    if (rendreStatut) return { statut: r.status, json: r.ok ? json : null };
    return r.ok ? json : null;
  } catch (e) {
    console.error(`[dalevoz] ${methode} ${chemin} KO: ${e.message}`);
    return rendreStatut ? { statut: 0, json: null } : null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * À quel espace et quel agent appartient le numéro appelé.
 *
 * Trois réponses, et pas deux, parce qu'elles n'appellent pas la même conduite :
 *   { canal }            le numéro est rattaché, on joue cet agent ;
 *   { inconnu: true }    la plateforme a répondu « ce numéro n'est chez personne » : on refuse ;
 *   { injoignable: true } la plateforme n'a pas répondu (réseau, panne, déploiement) :
 *                        on NE refuse PAS l'appel, on retombe sur la configuration
 *                        locale du pont. Sinon une panne de la console ferait
 *                        taire tous les numéros branchés d'un coup.
 */
export async function resoudreNumero(numero) {
  if (!dalevozActif || !numero) return { injoignable: true };
  const r = await appeler(`/api/voice/telephone?numero=${encodeURIComponent(numero)}`, { rendreStatut: true });
  if (r.statut === 200 && r.json) return { canal: r.json };
  if (r.statut === 404) return { inconnu: true };
  return { injoignable: true };
}

/** Instructions, voix et outils de la version PUBLIÉE de l'agent. */
export function chargerSession({ tenantId, agentSlug, locale }) {
  if (!dalevozActif) return Promise.resolve(null);
  const q = new URLSearchParams({ agent: agentSlug, ...(locale ? { locale } : {}) });
  return appeler(`/api/voice/session-config?${q}`, { tenantId });
}

/** Exécute un outil de l'agent côté plateforme (base de connaissance, outils HTTP...). */
export function executerOutil({ tenantId, agentSlug, outil, args, sessionId, locale }) {
  if (!dalevozActif) return Promise.resolve(null);
  return appeler("/api/voice/tool", {
    methode: "POST",
    tenantId,
    corps: { agent: agentSlug, tool: outil, args: args || {}, ...(sessionId ? { sessionId } : {}), ...(locale ? { locale } : {}) },
    timeout: Number(process.env.DALEVOZ_TOOL_TIMEOUT_MS || 8000),
  });
}

/**
 * LE TABLEAU DU RESTAURANT (17/09/2026). La tablette du comptoir règle pause,
 * délai, ruptures et quarts fermés dans Dale Voz ; le pont les relit, et y écrit
 * les commandes confirmées et les demandes à rappeler (avant, tout restait en
 * mémoire et disparaissait au redéploiement).
 *
 * Trois réponses pour la lecture, comme pour `resoudreNumero` :
 *   un objet     l'état du restaurant ;
 *   null         pas de tableau pour cet agent (404) : le pont reste en local ;
 *   undefined    Dale Voz n'a pas répondu : on garde le dernier état connu.
 */
export async function lireRestaurant({ tenantId, agentSlug }) {
  if (!dalevozActif || !tenantId || !agentSlug) return undefined;
  const r = await appeler(`/api/voice/restaurant?agent=${encodeURIComponent(agentSlug)}`, {
    tenantId,
    rendreStatut: true,
    timeout: Number(process.env.DALEVOZ_RESTAURANT_TIMEOUT_MS || 3000),
  });
  if (r.statut === 200 && r.json) return r.json;
  if (r.statut === 404) return null;
  return undefined;
}

/** Une commande confirmée. Rejouable : Dale Voz la reconnaît à son `appelId`. Rend `{ id, numero }` ou null. */
export function ecrireCommandeRestaurant({ tenantId, agentSlug }, corps) {
  if (!dalevozActif) return Promise.resolve(null);
  return appeler("/api/voice/restaurant/commande", { methode: "POST", tenantId, corps: { agent: agentSlug, ...corps }, timeout: 8000 });
}

/** Une demande à rappeler. Un second message du même appel complète le premier côté Dale Voz. */
export function ecrireRappelRestaurant({ tenantId, agentSlug }, corps) {
  if (!dalevozActif) return Promise.resolve(null);
  return appeler("/api/voice/restaurant/rappel", { methode: "POST", tenantId, corps: { agent: agentSlug, ...corps }, timeout: 8000 });
}

/** La carte du pont, pour que la tablette propose les ruptures. */
export function pousserCarteRestaurant({ tenantId, agentSlug }, carte) {
  if (!dalevozActif) return Promise.resolve(null);
  return appeler("/api/voice/restaurant/carte", { methode: "PUT", tenantId, corps: { agent: agentSlug, carte }, timeout: 8000 });
}

/**
 * Écrit l'appel dans Conversations et compte la minute. `appelId` est le CallSid :
 * un renvoi après coupure ne doit pas écrire le dialogue deux fois.
 */
export function enregistrerAppel({ tenantId, agentSlug, turns, appelId, dureeMs, userId, locale, diagnostic }) {
  if (!dalevozActif) return Promise.resolve(null);
  return appeler("/api/voice/persist", {
    methode: "POST",
    tenantId,
    corps: {
      agent: agentSlug,
      canal: "telephone",
      appelId,
      turns,
      dureeMs,
      userId: userId || undefined,
      locale: locale || undefined,
      diagnostic: diagnostic || undefined,
    },
    timeout: 10000,
  });
}

/**
 * Signature Twilio (X-Twilio-Signature) : HMAC-SHA1 de l'URL complète suivie des
 * paramètres POST triés par nom et concaténés clé+valeur, en base64.
 *
 * Sans cette vérification, l'adresse du webhook suffit à faire parler l'agent
 * d'un client et à brûler ses crédits : elle est publique par construction.
 */
export function signatureTwilioValide({ authToken, url, params, signature }) {
  if (!authToken || !signature) return false;
  let donnee = url;
  for (const cle of Object.keys(params).sort()) donnee += cle + params[cle];
  const attendu = crypto.createHmac("sha1", authToken).update(Buffer.from(donnee, "utf8")).digest("base64");
  const a = Buffer.from(attendu);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
