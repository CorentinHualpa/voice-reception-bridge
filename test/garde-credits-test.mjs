// Banc du garde-fou des credits ElevenLabs (lib/garde-credits.js), sans reseau : ElevenLabs, Railway et Resend simules.
// node test/garde-credits-test.mjs
import assert from "assert";
import { creerGardeCredits } from "../lib/garde-credits.js";

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; console.log("ok - " + msg); };
const CADRATIN = String.fromCharCode(0x2014);
const MIN = 60000;

const ENV = {
  CERVEAU: "eleven", ELEVENLABS_API_KEY: "cle-secrete-xi", GARDE_CREDITS_SEUIL: "20000", GARDE_RAILWAY_TOKEN: "jeton-secret-rw",
  GARDE_ALERTE_EMAIL: "coq@example.test", RESEND_API_KEY: "cle-secrete-re", GARDE_NOM: "Dany",
  RAILWAY_PROJECT_ID: "p", RAILWAY_ENVIRONMENT_ID: "e", RAILWAY_SERVICE_ID: "s",
};

// Faux fournisseurs : solde reglable, Railway qui refuse N fois puis accepte, mails et mutations enregistres.
function monde({ reste = 100000, soldeEnPanne = false, refusRailway = 0, jetonAutreProjet = false } = {}) {
  const m = { reste, soldeEnPanne, refusRailway, mails: [], railway: [], appels: 0, horloge: Date.parse("2026-10-26T20:00:00Z"), logs: [] };
  m.fetch = async (url, opts = {}) => {
    const rep = (status, corps) => ({ ok: status < 400, status, json: async () => corps });
    if (url.includes("elevenlabs.io")) {
      if (m.soldeEnPanne) return rep(500, {});
      return rep(200, { character_limit: 307272, character_count: 307272 - m.reste, next_character_count_reset_unix: 1794787200 });
    }
    if (url.includes("railway")) {
      assert.equal(opts.headers["Project-Access-Token"], "jeton-secret-rw", "le jeton de projet part dans Project-Access-Token");
      const corps = JSON.parse(opts.body);
      if (/projectToken/.test(corps.query)) return rep(200, { data: { projectToken: { projectId: jetonAutreProjet ? "autre" : "p", environmentId: "e" } } });
      if (m.refusRailway > 0) { m.refusRailway--; return rep(200, { errors: [{ message: "Not Authorized" }] }); }
      m.railway.push(corps);
      return rep(200, { data: {} });
    }
    if (url.includes("resend.com")) { m.mails.push(JSON.parse(opts.body)); return rep(200, { id: "x" }); }
    throw new Error("url inattendue " + url);
  };
  m.garde = (env = ENV, extra = {}) => creerGardeCredits({ env, fetchFn: m.fetch, log: (l) => m.logs.push(l), erreur: (l) => m.logs.push(l), appelsEnCours: () => m.appels, maintenant: () => m.horloge, ...extra });
  m.posees = () => m.railway.find((r) => /variableCollectionUpsert/.test(r.query))?.variables.i.variables;
  m.redeploiements = () => m.railway.filter((r) => /serviceInstanceRedeploy/.test(r.query)).length;
  return m;
}
const sansCadratin = (mails) => mails.every((x) => !(x.subject + x.text).includes(CADRATIN));

// Inactif
ok(monde().garde({ ...ENV, GARDE_CREDITS_SEUIL: "" }).inactif, "sans seuil, le garde-fou est inactif");
ok(!monde().garde().inactif, "en Eleven avec un seuil, actif");
{
  const m = monde(); const g = m.garde({ ...ENV, GARDE_PROFIL_SECOURS: JSON.stringify({ LECTURE: "grok" }) });
  ok(g.profil.CERVEAU === "grok", "un profil de secours qui ne change pas CERVEAU est refuse (sinon boucle de redeploiements)");
}

// Solde confortable : rien
{
  const m = monde({ reste: 100000 }); const g = m.garde();
  const d = await g.verifier();
  ok(d === 10 * MIN && !m.mails.length && !m.railway.length, "100 000 credits : ni mail ni bascule, prochaine lecture dans 10 min");
}

// Sous l'alerte (2 x seuil par defaut) : un seul mail, meme sur plusieurs lectures
{
  const m = monde({ reste: 35000 }); const g = m.garde();
  await g.verifier(); await g.verifier(); await g.verifier();
  ok(m.mails.length === 1 && !m.railway.length, "35 000 credits : un seul mail d'alerte en trois lectures, aucune bascule");
  ok(/passera bientôt sur Grok/.test(m.mails[0].subject) && /35 000/.test(m.mails[0].text), "le mail d'alerte dit le solde et ce qui va se passer");
  ok(sansCadratin(m.mails), "pas de tiret cadratin dans le mail d'alerte");
}

// Sous le seuil, aucun appel : bascule lancee, confirmee par le NOUVEAU processus
{
  const m = monde({ reste: 15000 }); const g = m.garde();
  const d = await g.verifier();
  ok(d === 30000, "15 000 credits : bascule lancee, on guette le remplacement toutes les 30 s");
  const v = m.posees();
  ok(v.CERVEAU === "grok" && v.LECTURE === "grok" && v.HEDGE_APRES_MS === "1000", "profil Grok de Dany pose");
  ok(m.railway[0].variables.i.skipDeploys === true && m.redeploiements() === 1, "variables posees sans deploiement, puis un redeploiement du meme code");
  ok(v.GARDE_BASCULE_SOLDE === "15000" && Date.parse(v.GARDE_BASCULE_LE) === m.horloge, "la bascule note son heure et le solde pour la confirmation");
  ok(!m.mails.length, "l'ancien processus n'annonce rien : seul le nouveau peut prouver que la bascule a pris");

  // Le nouveau processus demarre avec les variables REELLEMENT posees
  const neuf = m.garde({ ...ENV, ...v });
  ok(neuf.inactif, "relance avec les variables posees : le garde-fou s'eteint (pas de rebascule en boucle)");
  m.horloge += 2 * MIN;
  ok(await neuf.confirmerBascule(), "le nouveau processus confirme par mail");
  ok(/passé sur Grok/.test(m.mails[0].subject) && /15 000/.test(m.mails[0].text) && m.mails[0].to[0] === "coq@example.test", "mail de confirmation : solde, destinataire");
  ok(sansCadratin(m.mails), "pas de tiret cadratin dans la confirmation");
  const tard = monde(); m.horloge += 40 * MIN;
  ok(!(await tard.garde({ ...ENV, ...v }, { maintenant: () => m.horloge }).confirmerBascule()), "un redemarrage bien plus tard ne renvoie pas la confirmation");
}

// Bascule acceptee mais jamais effective (deploiement en file) : URGENT au bout de 15 min, une relance, puis arret
{
  const m = monde({ reste: 15000 }); const g = m.garde();
  await g.verifier();
  m.horloge += 10 * MIN;
  ok((await g.verifier()) === 30000 && !m.mails.length && m.redeploiements() === 1, "10 min apres : on attend encore le remplacement");
  m.horloge += 6 * MIN;
  ok((await g.verifier()) === null, "16 min apres : le garde-fou passe la main");
  ok(m.mails.length === 1 && /toujours pas passé sur Grok/.test(m.mails[0].subject), "mail URGENT : la bascule n'a pas pris");
  ok(m.redeploiements() === 2, "et un nouveau redeploiement est demande");
}

// Railway refuse une fois puis accepte : un seul URGENT, la bascule finit par partir
{
  const m = monde({ reste: 15000, refusRailway: 1 }); const g = m.garde();
  ok((await g.verifier()) === 30000 && m.mails.length === 1 && /a échoué/.test(m.mails[0].subject), "refus Railway : URGENT et nouvel essai dans 30 s");
  ok(/pont-moteur\.mjs dany grok/.test(m.mails[0].text), "le mail dit quoi faire de suite");
  m.horloge += 30000; await g.verifier();
  ok(m.redeploiements() === 1 && m.mails.length === 1, "au tour suivant la bascule part, sans second URGENT");
}
{
  const m = monde({ reste: 15000, refusRailway: 5 }); const g = m.garde();
  for (let i = 0; i < 5; i++) { await g.verifier(); m.horloge += 30000; }
  ok(m.mails.length === 1, "cinq refus d'affilee : un seul mail URGENT");
}

// Appel en cours : on attend la fin, sauf sous le plancher ou apres 30 min
{
  const m = monde({ reste: 15000 }); m.appels = 1; const g = m.garde();
  ok((await g.verifier()) === 30000 && !m.railway.length, "appel en cours : pas de bascule, nouvelle lecture dans 30 s");
  m.horloge += 30000; m.appels = 0; await g.verifier();
  ok(m.redeploiements() === 1, "l'appel fini, la bascule part");
}
{
  const m = monde({ reste: 15000 }); m.appels = 1; const g = m.garde();
  await g.verifier(); m.horloge += 20 * MIN; await g.verifier();
  ok(!m.railway.length, "20 min d'appel au-dessus du plancher : on attend encore");
  m.reste = 4000; m.horloge += 30000; await g.verifier();
  ok(m.redeploiements() === 1, "sous le plancher de 5 000 : bascule meme pendant l'appel");
}
{
  const m = monde({ reste: 15000 }); m.appels = 1; const g = m.garde();
  await g.verifier(); m.horloge += 31 * MIN; await g.verifier();
  ok(m.redeploiements() === 1, "appel (ou transfert) qui dure plus de 30 min : bascule quand meme");
}
{
  const m = monde({ reste: 15000 }); m.appels = 1; const g = m.garde();
  await g.verifier();
  m.reste = 120000; m.horloge += 25 * MIN; await g.verifier();
  m.reste = 15000; m.horloge += 10 * MIN; await g.verifier();
  ok(!m.railway.length, "apres une recharge puis une rechute, le delai d'attente repart de zero");
}

// Acces Railway absent : URGENT une fois, aucune tentative
{
  const m = monde({ reste: 15000 }); const g = m.garde({ ...ENV, GARDE_RAILWAY_TOKEN: "" });
  await g.verifier(); await g.verifier();
  ok(!m.railway.length && m.mails.length === 1 && /URGENT/.test(m.mails[0].subject), "sans jeton Railway : aucune tentative, un seul mail URGENT");
}

// Solde illisible : un mail au 3e echec, pas avant ni apres, jamais de bascule
{
  const m = monde({ soldeEnPanne: true }); const g = m.garde();
  await g.verifier(); await g.verifier();
  ok(!m.mails.length, "deux echecs de lecture : pas encore de mail");
  await g.verifier();
  ok(m.mails.length === 1 && /illisible/.test(m.mails[0].subject), "au troisieme echec : un mail");
  await g.verifier();
  ok(m.mails.length === 1 && !m.railway.length, "pas de mail a chaque echec suivant, et jamais de bascule");
}

// Epreuve au demarrage
{
  const m = monde(); const g = m.garde();
  ok((await g.eprouver()) && !m.mails.length, "jeton et mail en place : rien a signaler");
}
{
  const m = monde({ jetonAutreProjet: true }); const g = m.garde();
  ok(!(await g.eprouver()) && m.mails.length === 1 && /incomplet/.test(m.mails[0].subject), "jeton d'un autre projet : mail des le demarrage");
}
{
  const m = monde(); const g = m.garde({ ...ENV, RESEND_API_KEY: "" });
  ok(!(await g.eprouver()) && m.logs.some((l) => /GARDE-FOU INCOMPLET/.test(l)), "mail non configure : ligne d'erreur explicite au demarrage");
}

// Seuil d'alerte reglable
{
  const m = monde({ reste: 35000 }); const g = m.garde({ ...ENV, GARDE_CREDITS_ALERTE: "30000" });
  await g.verifier();
  ok(!m.mails.length, "GARDE_CREDITS_ALERTE=30000 : pas d'alerte a 35 000");
}

// demarrer() : la minuterie enchaine les lectures selon le delai rendu et s'arrete sur null
{
  const m = monde({ reste: 100000 }); const file = [];
  const g = m.garde(ENV, { planifier: (f, d) => { file.push({ f, d }); return { unref() {} }; } });
  g.demarrer({ premierDelaiMs: 1234 });
  ok(file.length === 1 && file[0].d === 1234, "demarrer : premiere lecture planifiee au delai demande");
  await file.shift().f();
  ok(file.length === 1 && file[0].d === 10 * MIN, "apres une lecture sans souci : suivante dans 10 min");
  m.reste = 15000; await file.shift().f();
  ok(file.length === 1 && file[0].d === 30000 && m.redeploiements() === 1, "sous le seuil : bascule et guet toutes les 30 s");
  m.horloge += 16 * MIN; await file.shift().f();
  ok(file.length === 0, "apres la relance de secours, la minuterie s'arrete");
  const inactifFile = []; const mi = monde();
  mi.garde({ ...ENV, CERVEAU: "grok" }, { planifier: (f, d) => { inactifFile.push(d); return {}; } }).demarrer();
  ok(!inactifFile.length, "inactif : aucune minuterie");
}

// Aucune cle ne fuit, ni dans les journaux ni dans les mails
{
  const m = monde({ reste: 15000, refusRailway: 2 }); const g = m.garde();
  await g.eprouver(); await g.verifier(); m.horloge += 30000; await g.verifier();
  const tout = m.logs.join("\n") + JSON.stringify(m.mails);
  ok(!/cle-secrete|jeton-secret/.test(tout), "aucune cle dans les journaux ni dans les mails");
}

console.log(`\n${n} verifications passees`);
