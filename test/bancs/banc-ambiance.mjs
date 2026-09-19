/**
 * BANC D'ECOUTE DES AMBIANCES
 *
 *   node test/bancs/banc-ambiance.mjs [dossier-de-sortie]
 *
 * Produit, pour chaque ambiance :
 *   - <id>-seul.wav        : l'ambiance seule, montee au niveau d'ecoute (pour juger le decor)
 *   - <id>-appel.wav       : ce que l'appelant entend VRAIMENT, au vrai gain, apres le codec mu-law 8 kHz,
 *                            avec une vraie phrase de l'agent puis un blanc de 2,5 s puis une reprise
 * plus :
 *   - _sans-ambiance.wav   : le meme appel sans aucun fond, pour comparer
 *   - index.html           : une page pour tout ecouter cote a cote
 *
 * La voix vient d'ElevenLabs (cle du coffre) et est mise en cache : le banc ne la redemande pas a chaque essai.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AMBIANCES, creerAmbiance, rendreWav } from "../../lib/ambiance.js";
import { ulawDecodeSample, ulawEncodeSample } from "../../lib/audio.js";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const SORTIE = process.argv[2] || path.join(ICI, "..", "..", "sortie-ambiance");
fs.mkdirSync(SORTIE, { recursive: true });

const TAUX = 8000;
const GAIN = Number(process.env.AMBIANCE_GAIN || 0.06);
const RATIO = Number(process.env.AMBIANCE_RATIO_VOIX || 0.55);

/* ---------- la voix de l'agent, en mu-law 8 kHz ---------- */

function lireEnv(f) {
  if (!fs.existsSync(f)) return {};
  return Object.fromEntries(
    fs.readFileSync(f, "utf8").split(/\r?\n/)
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
  );
}
const env = { ...lireEnv("C:/Users/msi/.secrets/api-keys.env"), ...lireEnv(path.join(ICI, "..", "..", ".env")) };

const PHRASE = process.env.PHRASE
  || "Bonjour, je vous appelle au sujet de votre demande. Votre conseiller est disponible jeudi à dix heures. Est-ce que cela vous convient ?";
const VOIX = process.env.VOIX_ID || "3C1zYzXNXNzrB66ON8rj"; // Jade, francaise
const cacheVoix = path.join(SORTIE, "_voix.ulaw");

async function voixUlaw() {
  if (fs.existsSync(cacheVoix)) return fs.readFileSync(cacheVoix);
  if (!env.ELEVENLABS_API_KEY) {
    console.error("Pas de cle ElevenLabs : le banc se rabat sur une voix simulee (moins parlant).");
    // Repli : une modulation qui occupe la bande de la voix, juste pour entendre le melange.
    const n = 4 * TAUX;
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      const env2 = Math.abs(Math.sin((i / TAUX) * Math.PI * 2.5));
      const v = Math.sin(i * 0.12) * 0.35 * env2 + Math.sin(i * 0.31) * 0.15 * env2;
      out[i] = ulawEncodeSample(Math.round(v * 32767));
    }
    return out;
  }
  console.log("Synthese de la phrase chez ElevenLabs…");
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOIX}?output_format=ulaw_8000`,
    {
      method: "POST",
      headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ text: PHRASE, model_id: "eleven_flash_v2_5" }),
    }
  );
  if (!r.ok) throw new Error(`ElevenLabs ${r.status} : ${(await r.text()).slice(0, 200)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(cacheVoix, buf);
  return buf;
}

/* ---------- outils WAV ---------- */

function ecrireWavDepuisUlaw(chemin, ulaw, { amplification = 1 } = {}) {
  const n = ulaw.length;
  const corps = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = ulawDecodeSample(ulaw[i]) * amplification;
    corps.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  const e = Buffer.alloc(44);
  e.write("RIFF", 0); e.writeUInt32LE(36 + corps.length, 4); e.write("WAVE", 8);
  e.write("fmt ", 12); e.writeUInt32LE(16, 16); e.writeUInt16LE(1, 20); e.writeUInt16LE(1, 22);
  e.writeUInt32LE(TAUX, 24); e.writeUInt32LE(TAUX * 2, 28); e.writeUInt16LE(2, 32); e.writeUInt16LE(16, 34);
  e.write("data", 36); e.writeUInt32LE(corps.length, 40);
  fs.writeFileSync(chemin, Buffer.concat([e, corps]));
}

const silence = (ms) => Buffer.alloc(Math.round((ms / 1000) * TAUX), 0xff); // mu-law 0xFF = zero

/* ---------- le banc ---------- */

const voix = await voixUlaw();
console.log(`Voix : ${(voix.length / TAUX).toFixed(1)} s`);

// Un appel type : accueil, blanc de 2,5 s (le pic de latence), reprise, blanc de fin.
const moitie = Math.floor(voix.length / 2);
const scenario = [
  { type: "voix", data: voix.subarray(0, moitie) },
  { type: "blanc", data: silence(2500) },
  { type: "voix", data: voix.subarray(moitie) },
  { type: "blanc", data: silence(1500) },
];

// Sans ambiance, pour comparer.
ecrireWavDepuisUlaw(path.join(SORTIE, "_sans-ambiance.wav"), Buffer.concat(scenario.map((s) => s.data)), { amplification: 3 });
console.log("_sans-ambiance.wav");

const lignes = [];
for (const [id, meta] of Object.entries(AMBIANCES)) {
  // 1. l'ambiance seule, montee pour etre jugee
  fs.writeFileSync(path.join(SORTIE, `${id}-seul.wav`), rendreWav(id, { secondes: 10, gain: 0.3 }));

  // 2. l'appel complet, au vrai gain, ambiance continue
  const amb = creerAmbiance({ preset: id, gain: GAIN, ratioVoix: RATIO });
  const morceaux = scenario.map((s) =>
    s.type === "voix" ? amb.melanger(s.data, { sousVoix: true }) : amb.melanger(s.data, { sousVoix: false })
  );
  ecrireWavDepuisUlaw(path.join(SORTIE, `${id}-appel.wav`), Buffer.concat(morceaux), { amplification: 3 });

  console.log(`${id.padEnd(16)} ${meta.libelle}`);
  lignes.push({ id, ...meta });
}

/* ---------- la page d'ecoute ---------- */

const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><title>Ambiances du pont</title>
<style>
:root{--f:#0a0c11;--p:#141824;--b:#262d3d;--t:#eef1f7;--t2:rgba(238,241,247,.88);--t3:rgba(238,241,247,.62);--a:#7b8cff}
body{margin:0;background:var(--f);color:var(--t);font:15px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;padding:32px 20px;max-width:940px;margin:0 auto}
h1{font-size:23px;margin:0 0 6px}
.sous{color:var(--t3);margin:0 0 26px;font-size:14px}
.c{background:var(--p);border:1px solid var(--b);border-radius:14px;padding:17px 19px;margin-bottom:14px}
.c h2{font-size:16px;margin:0 0 4px}
.c p{margin:0 0 13px;color:var(--t2);font-size:13.5px}
.r{display:flex;gap:22px;flex-wrap:wrap}
.r>div{flex:1;min-width:270px}
label{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--t3);margin-bottom:5px}
audio{width:100%;height:36px}
.ref{border-color:#4a3a1a;background:#1a1610}
b{color:var(--a)}
</style></head><body>
<h1>Ambiances de fond du pont téléphonique</h1>
<p class="sous">Écoutez d'abord <b>Sans ambiance</b>, puis les autres. Ce qui compte n'est pas le décor, c'est le blanc de 2,5 secondes au milieu : sans fond il s'entend comme une ligne coupée. Colonne de gauche : le décor seul, monté fort pour être jugé. Colonne de droite : ce que l'appelant entend vraiment, au gain réel (${GAIN}), après le codec téléphonique 8 kHz.</p>

<div class="c ref">
  <h2>Sans ambiance</h2>
  <p>La référence. C'est ce que fait le pont aujourd'hui.</p>
  <div class="r"><div><label>Appel</label><audio controls preload="none" src="_sans-ambiance.wav"></audio></div></div>
</div>

${lignes.map((l) => `<div class="c">
  <h2>${l.libelle}</h2>
  <p>${l.description}</p>
  <div class="r">
    <div><label>Le décor seul</label><audio controls preload="none" src="${l.id}-seul.wav"></audio></div>
    <div><label>L'appel, au gain réel</label><audio controls preload="none" src="${l.id}-appel.wav"></audio></div>
  </div>
</div>`).join("\n")}

<p class="sous">Gain du fond : ${GAIN} en crête dans les blancs, ${(GAIN * RATIO).toFixed(3)} pendant que l'agent parle. Les fichiers d'appel sont amplifiés 3 fois pour l'écoute au casque, le rapport entre la voix et le fond est inchangé.</p>
</body></html>`;

fs.writeFileSync(path.join(SORTIE, "index.html"), html, "utf8");
console.log(`\nPage d'ecoute : ${path.join(SORTIE, "index.html")}`);
