// Garde-fou des credits ElevenLabs (26/10/2026).
//
// Avec CERVEAU=eleven, tout l'appel (ecoute, cerveau, voix) consomme les credits du compte ElevenLabs, que partagent
// d'autres projets (films, demos, Chiara). Le 20/10/2026 le compte est tombe a zero et Dany ne pouvait plus repondre.
// Ce module lit le solde toutes les 10 min :
// - au demarrage, il eprouve le jeton Railway et la configuration du mail, et previent si l'un manque ;
// - sous GARDE_CREDITS_ALERTE (defaut : deux fois le seuil), un mail previent, une fois ;
// - sous GARDE_CREDITS_SEUIL, il pose le profil de secours (Grok) sur le service Railway et redeploie le meme code, des
//   qu'aucun appel (ni transfert) n'est en cours. Il n'attend pas au-dela de GARDE_CREDITS_PLANCHER credits ni de 30 min.
//   Un echec Railway se retente toutes les 30 s (mail URGENT une seule fois). Le NOUVEAU processus, demarre en Grok,
//   confirme la bascule par mail : la confirmation prouve que le remplacement a eu lieu. Si l'ancien processus tourne
//   encore 15 min apres, la bascule n'a pas pris : mail URGENT et nouveau redeploiement.
// Le retour sur Eleven reste une decision humaine (pont-moteur.mjs dany eleven, qui refuse sous 20 000 credits).
//
// Reglages : GARDE_CREDITS_SEUIL (absent ou 0 = inactif), GARDE_CREDITS_ALERTE, GARDE_CREDITS_PLANCHER (defaut 5000),
// GARDE_RAILWAY_TOKEN (jeton de PROJET Railway), GARDE_ALERTE_EMAIL, RESEND_API_KEY, GARDE_NOM,
// GARDE_PROFIL_SECOURS (JSON, defaut : profil Grok de Dany ; refuse s'il ne change pas CERVEAU).
// Pose par la bascule : GARDE_BASCULE_LE, GARDE_BASCULE_SOLDE. Railway injecte RAILWAY_PROJECT_ID,
// RAILWAY_ENVIRONMENT_ID et RAILWAY_SERVICE_ID.

const PROFIL_GROK = { CERVEAU: "grok", LECTURE: "grok", HEDGE_APRES_MS: "1000" };
const RAILWAY_GQL = "https://backboard.railway.com/graphql/v2";
const EXPEDITEUR = "Pont téléphonique <bonjour@dalevoz.ai>";
const RECHARGE = "https://elevenlabs.io/app/subscription";
const INTERVALLE_MS = 10 * 60 * 1000;
const INTERVALLE_ATTENTE_MS = 30 * 1000;
const ATTENTE_MAX_MS = 30 * 60 * 1000;
const REMPLACEMENT_MAX_MS = 15 * 60 * 1000;
const CONFIRMATION_FENETRE_MS = 30 * 60 * 1000;
const ECHECS_AVANT_ALERTE = 3;
const DELAI_RESEAU_MS = 15000;

const nombre = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const jour = (unix) => (unix ? new Date(unix * 1000).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" }) : "?");
const delai = () => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(DELAI_RESEAU_MS) : undefined);

export async function lireSolde({ cle, fetchFn = fetch }) {
  const r = await fetchFn("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": cle }, signal: delai() });
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
    signal: delai(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new Error(`Railway refuse (HTTP ${r.status}) ${JSON.stringify(j.errors || j).slice(0, 200)}`);
  return j.data;
}

export async function eprouverJeton({ jeton, ids, fetchFn = fetch }) {
  const d = await railway(jeton, `query { projectToken { projectId environmentId } }`, {}, fetchFn);
  if (d?.projectToken?.projectId !== ids.projectId || d?.projectToken?.environmentId !== ids.environmentId) {
    throw new Error("le jeton Railway ne vise pas ce projet et cet environnement");
  }
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
    signal: delai(),
  });
  if (!r.ok) throw new Error(`Resend refuse (HTTP ${r.status})`);
}

// Un appel a verifier() fait une lecture et rend le delai avant la suivante (null : plus rien a faire).
export function creerGardeCredits({ env = process.env, fetchFn = fetch, log = console.log, erreur = console.error, appelsEnCours = () => 0, maintenant = Date.now, planifier = setTimeout } = {}) {
  const seuil = Number(env.GARDE_CREDITS_SEUIL || 0);
  const alerte = Number(env.GARDE_CREDITS_ALERTE || seuil * 2);
  const plancher = Number(env.GARDE_CREDITS_PLANCHER || 5000);
  const nom = env.GARDE_NOM || env.AGENT_NAME || "l'agent";
  const ids = { projectId: env.RAILWAY_PROJECT_ID, environmentId: env.RAILWAY_ENVIRONMENT_ID, serviceId: env.RAILWAY_SERVICE_ID };
  const accesRailway = Boolean(env.GARDE_RAILWAY_TOKEN && ids.projectId && ids.environmentId && ids.serviceId);
  let profil = PROFIL_GROK;
  if (env.GARDE_PROFIL_SECOURS) {
    try {
      const p = JSON.parse(env.GARDE_PROFIL_SECOURS);
      // Un profil qui ne quitte pas Eleven redemarrerait en Eleven, rebasculerait, et ainsi de suite.
      if (["grok", "openai"].includes(String(p.CERVEAU || "").toLowerCase())) profil = p;
      else log("[garde] GARDE_PROFIL_SECOURS ne change pas CERVEAU vers grok ou openai : profil Grok par defaut");
    } catch { log("[garde] GARDE_PROFIL_SECOURS illisible : profil Grok par defaut"); }
  }

  let inactif = null;
  if (!seuil) inactif = "GARDE_CREDITS_SEUIL absent";
  else if ((env.CERVEAU || "").toLowerCase() !== "eleven") inactif = `CERVEAU=${env.CERVEAU || "grok"}, rien a garder`;
  else if (!env.ELEVENLABS_API_KEY) inactif = "ELEVENLABS_API_KEY absente";

  const etat = { alerteEnvoyee: false, basculeLancee: false, urgentEnvoye: false, echecs: 0, attenteDepuis: null, lanceeA: null, relanceFaite: false };

  async function prevenir(sujet, texte) {
    if (!env.RESEND_API_KEY || !env.GARDE_ALERTE_EMAIL) { erreur(`[garde] PAS DE MAIL (RESEND_API_KEY ou GARDE_ALERTE_EMAIL absent) : ${sujet}`); return false; }
    try { await envoyerAlerte({ cle: env.RESEND_API_KEY, a: env.GARDE_ALERTE_EMAIL, sujet, texte, fetchFn }); log(`[garde] mail envoye : ${sujet}`); return true; }
    catch (e) { erreur(`[garde] mail NON envoye (${e.message}) : ${sujet}`); return false; }
  }

  async function urgent(sujet, texte) {
    if (etat.urgentEnvoye) return;
    etat.urgentEnvoye = true;
    await prevenir(sujet, texte);
  }

  async function lancerBascule(solde) {
    try {
      await basculerSurSecours({ jeton: env.GARDE_RAILWAY_TOKEN, ids, profil: { ...profil, GARDE_BASCULE_LE: new Date(maintenant()).toISOString(), GARDE_BASCULE_SOLDE: String(solde.reste) }, fetchFn });
      etat.basculeLancee = true; etat.lanceeA = maintenant();
      log(`[garde] BASCULE lancee sur ${JSON.stringify(profil)} : le nouveau processus confirmera par mail`);
      return true;
    } catch (e) {
      erreur(`[garde] BASCULE EN ECHEC, nouvel essai dans 30 s : ${e.message}`);
      await urgent(`URGENT : la bascule de ${nom} sur Grok a échoué`, `Il reste ${nombre(solde.reste)} crédits ElevenLabs sur ${nombre(solde.limite)}. Le garde-fou essaie de basculer ${nom} sur Grok et Railway refuse (${e.message}). Il réessaie toutes les 30 secondes ; à zéro crédit, ${nom} ne répondra plus au téléphone.\n\nÀ faire de suite : recharger ${RECHARGE}, ou lancer pont-moteur.mjs dany grok.`);
      return false;
    }
  }

  async function verifier() {
    if (inactif) return null;
    // Bascule acceptee par Railway : ce processus aurait du etre remplace. S'il tourne encore, elle n'a pas pris.
    if (etat.basculeLancee) {
      if (maintenant() - etat.lanceeA < REMPLACEMENT_MAX_MS || etat.relanceFaite) return etat.relanceFaite ? null : INTERVALLE_ATTENTE_MS;
      etat.relanceFaite = true;
      erreur("[garde] toujours en Eleven 15 min apres la bascule : nouveau redeploiement");
      etat.urgentEnvoye = false;
      await urgent(`URGENT : ${nom} n'est toujours pas passé sur Grok`, `Railway a accepté la bascule de ${nom} sur Grok il y a 15 minutes, mais le pont tourne toujours sur ElevenLabs (déploiement en file ou en échec). Le garde-fou relance un déploiement une fois.\n\nÀ vérifier de suite : l'état du service bridge sur https://railway.com et https://status.railway.com ; sinon recharger ${RECHARGE}.`);
      try { await railway(env.GARDE_RAILWAY_TOKEN, `mutation($e: String!, $s: String!) { serviceInstanceRedeploy(environmentId: $e, serviceId: $s) }`, { e: ids.environmentId, s: ids.serviceId }, fetchFn); }
      catch (e) { erreur(`[garde] relance du deploiement refusee : ${e.message}`); }
      return null;
    }

    let solde;
    try {
      solde = await lireSolde({ cle: env.ELEVENLABS_API_KEY, fetchFn });
      etat.echecs = 0;
    } catch (e) {
      etat.echecs++;
      erreur(`[garde] ${e.message} (echec ${etat.echecs})`);
      if (etat.echecs === ECHECS_AVANT_ALERTE) {
        await prevenir(`${nom} : solde ElevenLabs illisible`, `Le pont n'arrive plus à lire le solde de crédits ElevenLabs depuis ${ECHECS_AVANT_ALERTE} essais (${e.message}). Le garde-fou ne peut donc plus basculer ${nom} sur Grok si le compte se vide.\n\nÀ vérifier : la clé ElevenLabs du service et ${RECHARGE}`);
      }
      return INTERVALLE_MS;
    }
    const { reste, limite, remise } = solde;
    log(`[garde] credits ElevenLabs restants ${reste} sur ${limite}, seuil ${seuil}, alerte ${alerte}`);

    if (reste < seuil) {
      if (!accesRailway) {
        await urgent(`URGENT : ${nom} ne peut pas passer sur Grok`, `Il reste ${nombre(reste)} crédits ElevenLabs sur ${nombre(limite)}. Le garde-fou devait basculer ${nom} sur Grok, mais il n'a pas les accès Railway nécessaires. À zéro crédit, ${nom} ne répondra plus au téléphone.\n\nÀ faire de suite : recharger ${RECHARGE}, ou lancer pont-moteur.mjs dany grok.`);
        return INTERVALLE_MS;
      }
      const enCours = appelsEnCours();
      if (enCours > 0) {
        if (etat.attenteDepuis === null) etat.attenteDepuis = maintenant();
        const attendu = maintenant() - etat.attenteDepuis;
        if (reste >= plancher && attendu < ATTENTE_MAX_MS) {
          log(`[garde] sous le seuil, ${enCours} appel(s) en cours : bascule a la fin de l'appel`);
          return INTERVALLE_ATTENTE_MS;
        }
        log(`[garde] sous le seuil avec ${enCours} appel(s) en cours, ${reste < plancher ? `moins de ${plancher} credits` : "30 min d'attente"} : bascule quand meme`);
      }
      await lancerBascule(solde); // reussie : on guette le remplacement ; en echec : nouvel essai
      return INTERVALLE_ATTENTE_MS;
    }

    etat.attenteDepuis = null;
    if (reste < alerte && !etat.alerteEnvoyee) {
      etat.alerteEnvoyee = true;
      await prevenir(`Crédits ElevenLabs bas : ${nom} passera bientôt sur Grok`, `Il reste ${nombre(reste)} crédits ElevenLabs sur ${nombre(limite)} (remise à zéro le ${jour(remise)}). ${nom} passera tout seul sur Grok sous ${nombre(seuil)} crédits, et un second mail le confirmera.\n\nPour garder la voix ElevenLabs : recharger le compte (${RECHARGE}).`);
    }
    return INTERVALLE_MS;
  }

  // Au demarrage d'un processus en Grok juste apres une bascule : c'est lui qui confirme, puisqu'il existe.
  async function confirmerBascule() {
    const le = Date.parse(env.GARDE_BASCULE_LE || "");
    if (!seuil || !le || maintenant() - le > CONFIRMATION_FENETRE_MS || (env.CERVEAU || "").toLowerCase() === "eleven") return false;
    const solde = Number(env.GARDE_BASCULE_SOLDE);
    return prevenir(`${nom} est passé sur Grok : crédits ElevenLabs bas`, `${Number.isFinite(solde) ? `Il restait ${nombre(solde)} crédits ElevenLabs. ` : ""}Sous ${nombre(seuil)}, le garde-fou a basculé ${nom} sur Grok et le pont a redémarré : les appels continuent normalement, avec la voix de Grok.\n\nPour revenir sur ElevenLabs : recharger le compte (${RECHARGE}), puis demander le retour dans une session Claude (pont-moteur.mjs dany eleven, qui refuse sous 20 000 crédits).`);
  }

  // Au demarrage en Eleven : le jeton et le mail sont eprouves maintenant, pas le jour ou les credits tombent.
  async function eprouver() {
    const manques = [];
    if (!env.RESEND_API_KEY || !env.GARDE_ALERTE_EMAIL) manques.push("configuration du mail (RESEND_API_KEY ou GARDE_ALERTE_EMAIL)");
    if (!accesRailway) manques.push("jeton Railway (GARDE_RAILWAY_TOKEN) ou identifiants du service");
    else {
      try { await eprouverJeton({ jeton: env.GARDE_RAILWAY_TOKEN, ids, fetchFn }); }
      catch (e) { manques.push(`jeton Railway refusé (${e.message})`); }
    }
    if (!manques.length) { log("[garde] jeton Railway et mail en place"); return true; }
    erreur(`[garde] GARDE-FOU INCOMPLET : ${manques.join(" ; ")}`);
    await prevenir(`Garde-fou de ${nom} incomplet`, `Au démarrage du pont, le garde-fou des crédits ElevenLabs n'a pas tout ce qu'il lui faut : ${manques.join(" ; ")}. Tant que ce n'est pas réglé, ${nom} ne pourra pas passer seul sur Grok si le compte se vide.`);
    return false;
  }

  function demarrer({ premierDelaiMs = 60 * 1000 } = {}) {
    if (inactif) {
      log(`[garde] credits ElevenLabs : inactif (${inactif})`);
      confirmerBascule().catch((e) => erreur(`[garde] confirmation : ${e.message}`));
      return;
    }
    log(`[garde] credits ElevenLabs : actif, bascule sur ${JSON.stringify(profil)} sous ${seuil}, mail d'alerte sous ${alerte}, plancher ${plancher}`);
    eprouver().catch((e) => erreur(`[garde] epreuve : ${e.message}`));
    const tour = (attente) => {
      const t = planifier(async () => {
        let suivant = INTERVALLE_MS;
        try { suivant = await verifier(); } catch (e) { erreur(`[garde] erreur inattendue : ${e.message}`); }
        if (suivant) tour(suivant);
      }, attente);
      t?.unref?.();
    };
    tour(premierDelaiMs);
  }

  return { verifier, demarrer, eprouver, confirmerBascule, etat, inactif, profil };
}
