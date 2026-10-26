// Banc du garde-fou des credits ElevenLabs (lib/garde-credits.js), sans reseau : ElevenLabs, Railway et Resend simules.
// node test/garde-credits-test.mjs
import assert from "assert";
import { creerGardeCredits } from "../lib/garde-credits.js";

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; console.log("ok - " + msg); };
const CADRATIN = String.fromCharCode(0x2014);

const ENV = {
  CERVEAU: "eleven", ELEVENLABS_API_KEY: "cle-secrete-xi", GARDE_CREDITS_SEUIL: "20000", GARDE_RAILWAY_TOKEN: "jeton-secret-rw",
  GARDE_ALERTE_EMAIL: "coq@example.test", RESEND_API_KEY: "cle-secrete-re", GARDE_NOM: "Dany",
  RAILWAY_PROJECT_ID: "p", RAILWAY_ENVIRONMENT_ID: "e", RAILWAY_SERVICE_ID: "s",
};

// Faux fournisseurs : solde reglable, Railway qui accepte ou refuse, mails et mutations enregistres.
function monde({ reste = 100000, soldeEnPanne = false, railwayRefuse = false } = {}) {
  const m = { reste, soldeEnPanne, railwayRefuse, mails: [], railway: [], appels: 0, horloge: 0, logs: [] };
  m.fetch = async (url, opts = {}) => {
    const rep = (status, corps) => ({ ok: status < 400, status, json: async () => corps });
    if (url.includes("elevenlabs.io")) {
      if (m.soldeEnPanne) return rep(500, {});
      return rep(200, { character_limit: 307272, character_count: 307272 - m.reste, next_character_count_reset_unix: 1794787200 });
    }
    if (url.includes("railway")) {
      assert.equal(opts.headers["Project-Access-Token"], "jeton-secret-rw", "le jeton de projet part dans Project-Access-Token");
      if (m.railwayRefuse) return rep(200, { errors: [{ message: "Not Authorized" }] });
      m.railway.push(JSON.parse(opts.body));
      return rep(200, { data: {} });
    }
    if (url.includes("resend.com")) { m.mails.push(JSON.parse(opts.body)); return rep(200, { id: "x" }); }
    throw new Error("url inattendue " + url);
  };
  m.garde = (env = ENV) => creerGardeCredits({ env, fetchFn: m.fetch, log: (l) => m.logs.push(l), appelsEnCours: () => m.appels, maintenant: () => m.horloge });
  return m;
}

// Inactif
ok(monde().garde({ ...ENV, GARDE_CREDITS_SEUIL: "" }).inactif, "sans seuil, le garde-fou est inactif");
ok(monde().garde({ ...ENV, CERVEAU: "grok" }).inactif, "en Grok, rien a garder : inactif (il s'eteint apres la bascule)");
ok(!monde().garde().inactif, "en Eleven avec un seuil, actif");

// Solde confortable : rien
{
  const m = monde({ reste: 100000 }); const g = m.garde();
  const d = await g.verifier();
  ok(d === 600000 && !m.mails.length && !m.railway.length, "100 000 credits : ni mail ni bascule, prochaine lecture dans 10 min");
}

// Sous l'alerte (2 x seuil par defaut) : un seul mail, meme sur plusieurs lectures
{
  const m = monde({ reste: 35000 }); const g = m.garde();
  await g.verifier(); await g.verifier(); await g.verifier();
  ok(m.mails.length === 1 && !m.railway.length, "35 000 credits : un seul mail d'alerte en trois lectures, aucune bascule");
  ok(/passera bientôt sur Grok/.test(m.mails[0].subject) && /35 000/.test(m.mails[0].text), "le mail d'alerte dit le solde et ce qui va se passer");
  ok(!(m.mails[0].text + m.mails[0].subject).includes(CADRATIN), "pas de tiret cadratin dans le mail");
}

// Sous le seuil, aucun appel en cours : bascule immediate, puis plus rien
{
  const m = monde({ reste: 15000 }); const g = m.garde();
  const d = await g.verifier();
  ok(d === null, "15 000 credits : la verification s'arrete apres la bascule");
  ok(m.railway.length === 2, "deux appels Railway : variables puis redeploiement");
  const vars = m.railway[0].variables.i;
  ok(vars.skipDeploys === true && vars.variables.CERVEAU === "grok" && vars.variables.LECTURE === "grok" && vars.variables.HEDGE_APRES_MS === "1000", "profil Grok de Dany pose sans deploiement");
  ok(vars.projectId === "p" && vars.environmentId === "e" && vars.serviceId === "s", "sur le service courant (identifiants injectes par Railway)");
  ok(/serviceInstanceRedeploy/.test(m.railway[1].query), "puis redeploiement du meme code");
  ok(m.mails.length === 1 && /passé sur Grok/.test(m.mails[0].subject), "un mail confirme la bascule");
  ok(m.mails[0].to[0] === "coq@example.test", "envoye a GARDE_ALERTE_EMAIL");
  ok(!(m.mails[0].text + m.mails[0].subject).includes(CADRATIN), "pas de tiret cadratin dans le mail de bascule");
  await g.verifier();
  ok(m.railway.length === 2 && m.mails.length === 1, "une seconde lecture ne rebascule pas et ne renvoie rien");
}

// Sous le seuil pendant un appel : attend la fin de l'appel
{
  const m = monde({ reste: 15000 }); m.appels = 1; const g = m.garde();
  const d1 = await g.verifier();
  ok(d1 === 30000 && !m.railway.length, "appel en cours : pas de bascule, nouvelle lecture dans 30 s");
  m.horloge += 30000; m.appels = 0;
  await g.verifier();
  ok(m.railway.length === 2, "l'appel fini, la bascule part");
}

// Appel interminable : bascule quand meme apres 5 min
{
  const m = monde({ reste: 15000 }); m.appels = 1; const g = m.garde();
  await g.verifier();
  m.horloge += 4 * 60000; await g.verifier();
  ok(!m.railway.length, "4 min d'appel : on attend encore");
  m.horloge += 61000; await g.verifier();
  ok(m.railway.length === 2, "au-dela de 5 min : bascule quand meme");
}

// Remonte au-dessus du seuil pendant l'attente (recharge) : l'attente repart de zero
{
  const m = monde({ reste: 15000 }); m.appels = 1; const g = m.garde();
  await g.verifier();
  m.reste = 120000; m.horloge += 4 * 60000; await g.verifier();
  m.reste = 15000; m.horloge += 2 * 60000; await g.verifier();
  ok(!m.railway.length, "apres une recharge puis une rechute, le delai de 5 min repart de zero");
}

// Railway refuse : mail urgent
{
  const m = monde({ reste: 15000, railwayRefuse: true }); const g = m.garde();
  await g.verifier();
  ok(m.mails.length === 1 && /URGENT/.test(m.mails[0].subject) && /a échoué/.test(m.mails[0].subject), "bascule refusee par Railway : mail URGENT");
  ok(/pont-moteur\.mjs dany grok/.test(m.mails[0].text), "le mail dit quoi faire de suite");
}

// Jeton Railway absent : mail urgent, pas d'appel Railway
{
  const m = monde({ reste: 15000 }); const g = m.garde({ ...ENV, GARDE_RAILWAY_TOKEN: "" });
  await g.verifier();
  ok(!m.railway.length && m.mails.length === 1 && /URGENT/.test(m.mails[0].subject), "sans jeton Railway : aucune tentative, mail URGENT");
}

// Solde illisible : un mail au 3e echec, pas avant ni apres
{
  const m = monde({ soldeEnPanne: true }); const g = m.garde();
  await g.verifier(); await g.verifier();
  ok(!m.mails.length, "deux echecs de lecture : pas encore de mail");
  await g.verifier();
  ok(m.mails.length === 1 && /illisible/.test(m.mails[0].subject), "au troisieme echec : un mail");
  await g.verifier();
  ok(m.mails.length === 1, "pas de mail a chaque echec suivant");
  ok(!m.railway.length, "un solde illisible ne declenche jamais de bascule");
}

// Seuil d'alerte reglable
{
  const m = monde({ reste: 35000 }); const g = m.garde({ ...ENV, GARDE_CREDITS_ALERTE: "30000" });
  await g.verifier();
  ok(!m.mails.length, "GARDE_CREDITS_ALERTE=30000 : pas d'alerte a 35 000");
}

// Aucune cle ne fuit, ni dans les journaux ni dans les mails
{
  const m = monde({ reste: 15000, railwayRefuse: true }); const g = m.garde();
  await g.verifier();
  const tout = m.logs.join("\n") + JSON.stringify(m.mails);
  ok(!/cle-secrete|jeton-secret/.test(tout), "aucune cle dans les journaux ni dans les mails");
}

console.log(`\n${n} verifications passees`);
