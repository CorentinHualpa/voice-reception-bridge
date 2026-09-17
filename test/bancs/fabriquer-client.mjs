// Fabrique la voix du client simulé des bancs (fixtures/client-*.wav, mono 8 kHz) : un appelant de Motralec qui
// demande un devis. Voix de synthèse OpenAI (OPENAI_API_KEY du vault). Une pause se note « | » dans le texte et
// devient PAUSE_MS de silence, pour éprouver la fin de tour au milieu d'une phrase.
// Usage : node test/bancs/fabriquer-client.mjs   (ne refait que les fichiers absents ; --tout pour tout refaire)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { FIXTURES, cle, wavMono8k } from "./config-banc.mjs";

const PAUSE_MS = 850;
export const PHRASES = {
  besoin: "Bonjour, j'aurais besoin d'un devis pour une pompe de relevage, pour ma maison.",
  mmm: "Mmm.",
  "nom-pause": "Oui, alors je m'appelle | Jean Dupont.",
  email: "C'est jean point dupont arobase gmail point com.",
  "par-dessus": "Oui oui, c'est ça.",
  confirmer: "Oui, c'est bien ça.",
  ville: "J'habite à Herblay.",
  "au-revoir": "Merci beaucoup, au revoir.",
};

const tout = process.argv.includes("--tout");
fs.mkdirSync(FIXTURES, { recursive: true });
for (const [nom, texte] of Object.entries(PHRASES)) {
  const fichier = path.join(FIXTURES, `client-${nom}.wav`);
  if (!tout && fs.existsSync(fichier)) continue;
  const morceaux = [];
  for (const [i, bout] of texte.split("|").map((x) => x.trim()).entries()) {
    if (i > 0) morceaux.push(Buffer.alloc(Math.round((PAUSE_MS / 1000) * 16000)));
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${cle("OPENAI_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "ash", input: bout, response_format: "wav", instructions: "Un particulier français au téléphone, ton naturel, débit normal." }),
    });
    if (!r.ok) throw new Error(`TTS ${nom} : ${r.status} ${await r.text()}`);
    const source = path.join(FIXTURES, `.tmp-${nom}-${i}.wav`);
    fs.writeFileSync(source, Buffer.from(await r.arrayBuffer()));
    // Silences de début et de fin retirés ; un « Mmm » murmuré passe sous le seuil et disparaîtrait, on le garde alors entier.
    const ffmpeg = (filtre) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", source, ...(filtre ? ["-af", filtre] : []), "-f", "s16le", "-ac", "1", "-ar", "8000", "-"], { maxBuffer: 64 * 1024 * 1024 });
    let pcm = ffmpeg("silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse");
    if (pcm.length < 3200) pcm = ffmpeg("");
    fs.rmSync(source);
    morceaux.push(pcm);
  }
  const pcm = Buffer.concat(morceaux);
  fs.writeFileSync(fichier, wavMono8k(pcm));
  console.log(`${path.basename(fichier)} ${(pcm.length / 16000).toFixed(2)} s`);
}
