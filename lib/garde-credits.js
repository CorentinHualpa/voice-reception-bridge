// Garde-fou des credits ElevenLabs (26/10/2026).
//
// Avec CERVEAU=eleven, tout l'appel (ecoute, cerveau, voix) consomme les credits du compte ElevenLabs, que partagent
// d'autres projets (films, demos, Chiara). Le 20/10/2026 le compte est tombe a zero et Dany ne pouvait plus repondre.
// Ce module lit le solde toutes les 10 min :
// - sous GARDE_CREDITS_ALERTE (defaut : deux fois le seuil), un mail previent, une fois ;
// - sous GARDE_CREDITS_SEUIL, il pose le profil de secours (Grok) sur le service Railway et redeploie le meme code, des
//   qu'aucun appel n'est en cours (5 min d'attente au plus), puis previent par mail. Le nouveau processus demarre en
//   Grok, donc le garde-fou s'eteint de lui-meme. Le retour sur Eleven reste une decision humaine
//   (pont-moteur.mjs dany eleven, qui refuse sous 20 000 credits).
//
// Reglages : GARDE_CREDITS_SEUIL (absent ou 0 = inactif), GARDE_CREDITS_ALERTE, GARDE_RAILWAY_TOKEN (jeton de PROJET
// Railway), GARDE_ALERTE_EMAIL, RESEND_API_KEY, GARDE_PROFIL_SECOURS (JSON, defaut : profil Grok de Dany), GARDE_NOM.
// Railway injecte RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID et RAILWAY_SERVICE_ID.

const PROFIL_GROK = { CERVEAU: "grok", LECTURE: "grok", HEDGE_APRES_MS: "1000" };
const RAILWAY_GQL = "https://backboard.railway.com/graphql/v2";
const EXPEDITEUR = "Pont téléphonique <bonjour@dalevoz.ai>";
const RECHARGE = "https://elevenlabs.io/app/subscription";
const INTERVALLE_MS = 10 * 60 * 1000;
const INTERVALLE_ATTENTE_MS = 30 * 1000;
const ATTENTE_MAX_MS = 5 * 60 * 1000;
const ECHECS_AVANT_ALERTE = 3;

const nombre = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const jour = (unix) => (unix ? new Date(unix * 1000).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" }) : "?");

export async function lireSolde({ cle, fetchFn = fetch }) {
  const r = await fetchFn("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": cle } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || typeof j.character_limit !== "number" || typeof j.character_count !== "number") {
    throw new Error(`solde ElevenLabs illisible (HTTP ${r.status})`);
  }
  return { reste: j.character_limit - j.character_count, limite: j.character_limit, remise: j.next_character_count_reset_unix };
}

async function railway(jeton, query, variables, fetchFn) {
  const r = await fetchFn(RAILWAY_GQL, {
    method: "POST",
    headers: { "content-type": "application/json", "Project-Access-Token": jeton },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new Error(`Railway refuse (HTTP ${r.status}) ${JSON.stringify(j.errors || j).slice(0, 200)}`);
  return j.data;
}

export async function basculerSurSecours({ jeton, ids, profil, fetchFn = fetch }) {
  await railway(jeton, `mutation($i: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $i) }`,
    { i: { ...ids, variables: profil, skipDeploys: true } }, fetchFn);
  await railway(jeton, `mutation($e: String!, $s: String!) { serviceInstanceRedeploy(environmentId: $e, serviceId: $s) }`,
    { e: ids.environmentId, s: ids.serviceId }, fetchFn);
}

export async function envoyerAlerte({ cle, a, sujet, texte, fetchFn = fetch }) {
  const r = await fetchFn("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${cle}`, "content-type": "application/json" },
    body: JSON.stringify({ from: EXPEDITEUR, to: [a], subject: sujet, text: texte }),
  });
  if (!r.ok) throw new Error(`Resend refuse (HTTP ${r.status})`);
}

// Un appel a verifier() fait une lecture et rend le delai avant la suivante.
export function creerGardeCredits({ env = process.env, fetchFn = fetch, log = console.log, appelsEnCours = () => 0, maintenant = Date.now } = {}) {
  const seuil = Number(env.GARDE_CREDITS_SEUIL || 0);
  const alerte = Number(env.GARDE_CREDITS_ALERTE || seuil * 2);
  const nom = env.GARDE_NOM || env.AGENT_NAME || "l'agent";
  const ids = { projectId: env.RAILWAY_PROJECT_ID, environmentId: env.RAILWAY_ENVIRONMENT_ID, serviceId: env.RAILWAY_SERVICE_ID };
  let profil = PROFIL_GROK;
  try { if (env.GARDE_PROFIL_SECOURS) profil = JSON.parse(env.GARDE_PROFIL_SECOURS); } catch { log("[garde] GARDE_PROFIL_SECOURS illisible : profil Grok par defaut"); }

  let inactif = null;
  if (!seuil) inactif = "GARDE_CREDITS_SEUIL absent";
  else if ((env.CERVEAU || "").toLowerCase() !== "eleven") inactif = `CERVEAU=${env.CERVEAU || "grok"}, rien a garder`;
  else if (!env.ELEVENLABS_API_KEY) inactif = "ELEVENLABS_API_KEY absente";

  const etat = { alerteEnvoyee: false, basculeFaite: false, echecs: 0, attenteDepuis: null };

  async function prevenir(sujet, texte) {
    if (!env.RESEND_API_KEY || !env.GARDE_ALERTE_EMAIL) { log(`[garde] PAS DE MAIL (RESEND_API_KEY ou GARDE_ALERTE_EMAIL absent) : ${sujet}`); return; }
    try { await envoyerAlerte({ cle: env.RESEND_API_KEY, a: env.GARDE_ALERTE_EMAIL, sujet, texte, fetchFn }); log(`[garde] mail envoye : ${sujet}`); }
    catch (e) { log(`[garde] mail NON envoye (${e.message}) : ${sujet}`); }
  }

  async function verifier() {
    if (inactif || etat.basculeFaite) return null;
    let solde;
    try {
      solde = await lireSolde({ cle: env.ELEVENLABS_API_KEY, fetchFn });
      etat.echecs = 0;
    } catch (e) {
      etat.echecs++;
      log(`[garde] ${e.message} (echec ${etat.echecs})`);
      if (etat.echecs === ECHECS_AVANT_ALERTE) {
        await prevenir(`${nom} : solde ElevenLabs illisible`, `Le pont n'arrive plus à lire le solde de crédits ElevenLabs depuis ${ECHECS_AVANT_ALERTE} essais (${e.message}). Le garde-fou ne peut donc plus basculer ${nom} sur Grok si le compte se vide.\n\nÀ vérifier : la clé ElevenLabs du service et ${RECHARGE}`);
      }
      return INTERVALLE_MS;
    }
    const { reste, limite, remise } = solde;
    const resteLisible = `${nombre(reste)} crédits ElevenLabs sur ${nombre(limite)} (remise à zéro le ${jour(remise)})`;
    log(`[garde] credits ElevenLabs restants ${reste} sur ${limite}, seuil ${seuil}, alerte ${alerte}`);

    if (reste < seuil) {
      const enCours = appelsEnCours();
      if (enCours > 0) {
        if (etat.attenteDepuis === null) etat.attenteDepuis = maintenant();
        if (maintenant() - etat.attenteDepuis < ATTENTE_MAX_MS) {
          log(`[garde] sous le seuil, ${enCours} appel(s) en cours : bascule a la fin de l'appel`);
          return INTERVALLE_ATTENTE_MS;
        }
        log(`[garde] sous le seuil, appel toujours en cours apres 5 min : bascule quand meme`);
      }
      etat.basculeFaite = true;
      if (!env.GARDE_RAILWAY_TOKEN || !ids.projectId || !ids.environmentId || !ids.serviceId) {
        log("[garde] BASCULE IMPOSSIBLE : GARDE_RAILWAY_TOKEN ou identifiants Railway absents");
        await prevenir(`URGENT : ${nom} n'a pas pu passer sur Grok`, `Il reste ${resteLisible}. Le garde-fou devait basculer ${nom} sur Grok, mais il n'a pas les accès Railway nécessaires. À zéro crédit, ${nom} ne répondra plus au téléphone.\n\nÀ faire de suite : recharger ${RECHARGE}, ou lancer pont-moteur.mjs dany grok.`);
        return null;
      }
      try {
        await basculerSurSecours({ jeton: env.GARDE_RAILWAY_TOKEN, ids, profil, fetchFn });
        log(`[garde] BASCULE sur le profil de secours ${JSON.stringify(profil)}, redeploiement lance`);
        await prevenir(`${nom} est passé sur Grok : crédits ElevenLabs bas`, `Il reste ${resteLisible}. Sous ${nombre(seuil)}, le pont a basculé ${nom} sur Grok tout seul et s'est redéployé : les appels continuent normalement, avec la voix de Grok.\n\nPour revenir sur ElevenLabs : recharger le compte (${RECHARGE}), puis demander le retour dans une session Claude (pont-moteur.mjs dany eleven, qui refuse sous 20 000 crédits).`);
      } catch (e) {
        log(`[garde] BASCULE EN ECHEC : ${e.message}`);
        await prevenir(`URGENT : la bascule de ${nom} sur Grok a échoué`, `Il reste ${resteLisible}. Le garde-fou a essayé de basculer ${nom} sur Grok et Railway a refusé (${e.message}). À zéro crédit, ${nom} ne répondra plus au téléphone.\n\nÀ faire de suite : recharger ${RECHARGE}, ou lancer pont-moteur.mjs dany grok.`);
      }
      return null;
    }

    etat.attenteDepuis = null;
    if (reste < alerte && !etat.alerteEnvoyee) {
      etat.alerteEnvoyee = true;
      await prevenir(`Crédits ElevenLabs bas : ${nom} passera bientôt sur Grok`, `Il reste ${resteLisible}. ${nom} passera tout seul sur Grok sous ${nombre(seuil)} crédits, et un second mail le confirmera.\n\nPour garder la voix ElevenLabs : recharger le compte (${RECHARGE}).`);
    }
    return INTERVALLE_MS;
  }

  function demarrer({ premierDelaiMs = 60 * 1000 } = {}) {
    if (inactif) { log(`[garde] credits ElevenLabs : inactif (${inactif})`); return; }
    log(`[garde] credits ElevenLabs : actif, bascule sur ${JSON.stringify(profil)} sous ${seuil}, mail d'alerte sous ${alerte}`);
    const tour = async (delai) => {
      const t = setTimeout(async () => {
        let suivant = INTERVALLE_MS;
        try { suivant = await verifier(); } catch (e) { log(`[garde] erreur inattendue : ${e.message}`); }
        if (suivant) tour(suivant);
      }, delai);
      t.unref?.();
    };
    tour(premierDelaiMs);
  }

  return { verifier, demarrer, etat, inactif };
}
