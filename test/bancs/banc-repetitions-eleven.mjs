// Repetitions de Dany sur Eleven Realtime (27/10/2026) : rejoue l'appel reel du 27/10 a 12:19 UTC (garantie, nom, email
// dicte d'un trait, « Ouais, parfait. », ville breve) et compte, par appel, ce que l'appelant ne doit jamais entendre :
// une seconde relecture de l'email, « C'est corrige » apres une simple confirmation, la ville demandee deux fois.
// Cause mesuree : le tampon d'entree d'Eleven n'est jamais consomme, chaque message du client reprend TOUT l'appel.
// Lance banc-dany.mjs (pont complet en local, faux Twilio, rien en production) N fois, l'un apres l'autre.
// Usage : node test/bancs/banc-repetitions-eleven.mjs <appels=3> <prefixe=rep> [dossier de sortie]
//         Variables du pont surchargeables comme pour banc-dany.mjs (CERVEAU, NOTE_DE_TOUR...).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const [nArg, prefixe = "rep", sortieArg] = process.argv.slice(2);
const N = Number(nArg || 3);
const S = sortieArg || path.join(ICI, ".sorties");
fs.mkdirSync(S, { recursive: true });
const REPLIQUES = process.env.REPLIQUES || JSON.stringify([
  "Une garantie.",
  "Timothée Henkel.",
  "sas point roussel point contact arobase gmail point com.",
  "Ouais, parfait.",
  "Senon.",
  "Ouais.",
  "Merci, au revoir.",
]);
const PROFIL = {
  CERVEAU: "eleven", LECTURE: "elevenlabs", ELEVEN_REALTIME_MODEL: "eleven_realtime_v1_max",
  ELEVEN_REALTIME_VOIX: "GRKzEhPHr0FFNDlaqQei", HEDGE_APRES_MS: "0", GROK_SPEED: "1.15", FIN_DE_TOUR_MS: "1000",
};
const env = { ...process.env, BANC_SORTIE: S, REPLIQUES };
for (const [k, v] of Object.entries(PROFIL)) if (env[k] === undefined) env[k] = v;

const resultats = [];
for (let i = 1; i <= N; i++) {
  const nom = `${prefixe}-${i}`;
  const r = spawnSync(process.execPath, [path.join(ICI, "banc-dany.mjs"), nom], { env, encoding: "utf8", timeout: 6 * 60 * 1000 });
  const log = fs.existsSync(path.join(S, `${nom}.log`)) ? fs.readFileSync(path.join(S, `${nom}.log`), "utf8") : r.stdout || "";
  const agent = log.split(/\r?\n/).filter((l) => /^\s*[\d.]+\s+Agent :/.test(l)).map((l) => l.replace(/^\s*[\d.]+\s+Agent :\s*/, ""));
  const res = {
    appel: nom,
    // Motifs larges (relecture critique du 27/10) : toute phrase de l'agent qui dit « arobase » est une relecture ou une
    // question sur l'email ; toute question qui parle de ville ou de commune compte, quelle que soit sa tournure.
    relectures: agent.filter((l) => /arobase/i.test(l)).length,
    corrige: agent.filter((l) => /corrig/i.test(l)).length,
    ville: agent.filter((l) => /\b(ville|commune)\b/i.test(l) && /\?/.test(l)).length,
    numero: agent.some((l) => /rappellera|rappeler au|z[ée]ro six/i.test(l)),
    cloture: agent.some((l) => /remercie pour votre appel/i.test(l)),
  };
  res.ok = res.relectures === 1 && res.corrige === 0 && res.ville === 1 && res.numero && res.cloture;
  resultats.push(res);
  console.log(`${nom} : relectures=${res.relectures} corrige=${res.corrige} ville=${res.ville} numero=${res.numero ? "oui" : "NON"} cloture=${res.cloture ? "oui" : "NON"} ${res.ok ? "OK" : "DEFAUT"}`);
  for (const l of agent) console.log(`   Agent : ${l.slice(0, 160)}`);
}
const bons = resultats.filter((r) => r.ok).length;
console.log(`\n${bons}/${resultats.length} appels sans repetition (attendu : 1 relecture, 0 « corrige », ville demandee 1 fois, numero relu, cloture)`);
fs.writeFileSync(path.join(S, `${prefixe}-resultats.json`), JSON.stringify(resultats, null, 1));
