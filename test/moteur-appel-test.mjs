// Banc du moteur d'un appel (lib/moteur-appel.js), sans reseau.
// node test/moteur-appel-test.mjs
import assert from "assert";
import { envLectureDeLAppel, moteurDeLAppel } from "../lib/moteur-appel.js";

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; console.log("ok - " + msg); };

const JADE = "3C1zYzXNXNzrB66ON8rj";
const env = { ELEVENLABS_API_KEY: "x", OPENAI_API_KEY: "y", ELEVEN_VOIX: "AiJXmyKRr43pvJUsR0tP", ELEVEN_BALISE: "[warm]" };
const eleven = { eleven: true, openai: false };
const grokService = { eleven: false, openai: false };
const openaiService = { eleven: false, openai: true };

// Sans reglage de l'agent : le service decide, exactement comme avant.
for (const [service, attendu] of [[eleven, "eleven"], [grokService, "grok"], [openaiService, "openai"]]) {
  const m = moteurDeLAppel({ oral: undefined, service, env });
  ok(m.famille === attendu && m.source === "service" && m.modele === null && m.voixEleven === null, `sans oral, service ${attendu} : inchange`);
  ok(moteurDeLAppel({ oral: null, service, env }).famille === attendu, `oral null, service ${attendu} : inchange`);
  ok(moteurDeLAppel({ oral: { famille: "inconnue" }, service, env }).source === "service", `famille inconnue, service ${attendu} : le service decide`);
}

// Economique.
{
  const m = moteurDeLAppel({ oral: { cran: "economique", famille: "grok", modele: "grok-voice-latest", voix: "ara" }, service: eleven, env });
  ok(m.famille === "grok" && m.source === "agent" && m.modele === "grok-voice-latest", "Economique sur un service Eleven : Grok");
  ok(moteurDeLAppel({ oral: { famille: "grok", modele: "eleven_realtime_v1_max" }, service: eleven, env }).modele === null, "Economique : un modele non Grok est ignore");
}

// Naturelle.
{
  const m = moteurDeLAppel({ oral: { cran: "naturelle", famille: "eleven-max", modele: "eleven_realtime_v1_max", voix: JADE }, service: grokService, env });
  ok(m.famille === "eleven" && m.voixEleven === JADE && m.modele === "eleven_realtime_v1_max", "Naturelle sur un service Grok : Eleven avec la voix de l'agent");
  const b = moteurDeLAppel({ oral: { famille: "eleven-max", voix: JADE }, service: eleven, env: { ...env, GARDE_BASCULE_LE: "2026-11-07T10:00:00Z" } });
  ok(b.famille === "grok" && /garde-fou/.test(b.raison), "Naturelle apres la bascule du garde-fou : Grok");
  const c = moteurDeLAppel({ oral: { famille: "eleven-max", voix: JADE }, service: grokService, env: { ...env, ELEVENLABS_API_KEY: "" } });
  ok(c.famille === "grok" && /ELEVENLABS_API_KEY/.test(c.raison), "Naturelle sans cle ElevenLabs : Grok");
  const d = moteurDeLAppel({ oral: { famille: "eleven-max", voix: "brian" }, service: eleven, env });
  ok(d.famille === "grok" && /voix/.test(d.raison), "Naturelle avec une voix de mauvaise forme : Grok");
  ok(moteurDeLAppel({ oral: { famille: "eleven-max", modele: "gpt-realtime", voix: JADE }, service: eleven, env }).modele === null, "Naturelle : un modele non Eleven est ignore");
}

// Reactive.
{
  const m = moteurDeLAppel({ oral: { cran: "reactive", famille: "openai-realtime", modele: "gpt-realtime-1.5", voix: JADE, lecture: { voix: JADE } }, service: eleven, env });
  ok(m.famille === "openai" && m.modele === "gpt-realtime-1.5" && m.voixLecture === JADE, "Reactive : OpenAI 1.5 lu par la voix de l'agent");
  ok(moteurDeLAppel({ oral: { famille: "openai-realtime", voix: JADE }, service: eleven, env }).modele === "gpt-realtime-1.5", "Reactive : 1.5 par defaut, jamais gpt-realtime");
  ok(moteurDeLAppel({ oral: { famille: "openai-realtime", voix: JADE }, service: eleven, env: { ...env, OPENAI_API_KEY: "" } }).famille === "grok", "Reactive sans cle OpenAI : Grok");
  ok(moteurDeLAppel({ oral: { famille: "openai-realtime", voix: JADE }, service: eleven, env: { ...env, ELEVENLABS_API_KEY: "" } }).famille === "grok", "Reactive sans cle ElevenLabs : Grok");
  ok(moteurDeLAppel({ oral: { famille: "openai-realtime", voix: JADE }, service: eleven, env: { ...env, GARDE_BASCULE_LE: "x" } }).famille === "grok", "Reactive apres la bascule : Grok");
}

// Voix de la ligne (null) et solde ElevenLabs.
{
  const m = moteurDeLAppel({ oral: { famille: "eleven-max", voix: null }, service: eleven, env });
  ok(m.famille === "eleven" && m.voixEleven === null && m.raison === null, "Naturelle sans voix : Eleven avec la voix de la ligne (jamais une voix imposee)");
  const r = moteurDeLAppel({ oral: { famille: "openai-realtime", voix: null, lecture: { voix: null } }, service: eleven, env });
  ok(r.famille === "openai" && r.voixLecture === null, "Reactive sans voix : lu par la voix de la ligne");
  ok(moteurDeLAppel({ oral: { famille: "eleven-max", voix: JADE }, service: eleven, env, soldeEleven: 1200 }).famille === "grok", "credits bas (1200 < 5000) : Grok");
  ok(moteurDeLAppel({ oral: { famille: "eleven-max", voix: JADE }, service: eleven, env, soldeEleven: null }).famille === "eleven", "solde inconnu : pas de repli");
  ok(moteurDeLAppel({ oral: { famille: "eleven-max", voix: JADE }, service: eleven, env: { ...env, GARDE_CREDITS_SEUIL: "1000" }, soldeEleven: 1200 }).famille === "eleven", "seuil regle a 1000 : 1200 suffit");
  ok(moteurDeLAppel({ oral: { famille: "openai-realtime", voix: JADE }, service: eleven, env, soldeEleven: 10 }).famille === "grok", "Reactive, credits bas : Grok (la lecture est ElevenLabs)");
  ok(moteurDeLAppel({ oral: undefined, service: eleven, env, soldeEleven: 10 }).famille === "eleven", "sans choix de l'agent : le solde ne change rien (comportement d'avant)");
}

// Lecture de l'appel.
{
  const ligne = envLectureDeLAppel(env, null, "es");
  ok(ligne.ELEVEN_VOIX === env.ELEVEN_VOIX && ligne.ELEVEN_BALISE === "[warm]" && ligne.ELEVEN_LANGUE === "es", "voix de la ligne : celle du service, sa balise, la langue de l'agent");
  const meme = envLectureDeLAppel(env, env.ELEVEN_VOIX);
  ok(meme.ELEVEN_BALISE === "[warm]" && meme.LECTURE === "elevenlabs", "meme voix que le service : la balise reste");
  const autre = envLectureDeLAppel(env, JADE);
  ok(autre.ELEVEN_VOIX === JADE && autre.ELEVEN_BALISE === "", "autre voix : la balise du service tombe");
  ok(envLectureDeLAppel(env, null).ELEVEN_VOIX === env.ELEVEN_VOIX && envLectureDeLAppel(env, null).ELEVEN_LANGUE === undefined, "sans voix ni langue : la voix du service, langue inchangee");
}

console.log(`\n${n} verifications passees`);
