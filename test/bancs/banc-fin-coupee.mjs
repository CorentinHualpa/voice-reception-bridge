// FINS DE PHRASE COUPÉES : où se perd la fin d'une réponse qui finit sur une question, et un format de sortie
// l'évite-t-il ? Même phrase dite mot pour mot dans quatre sessions en parallèle, une par format de sortie de Grok :
// pcm 8 kHz (le pont), pcm 16 kHz, pcm 24 kHz, pcmu natif. Pour chaque rendu : énergie dans les 150 dernières ms
// (fin abrupte si > 600), transcription de Grok (le « ? » final est-il là ?) et transcription indépendante de
// l'audio (le dernier mot attendu est-il entendu ?).
// Usage : node test/bancs/banc-fin-coupee.mjs [essais=4] [voix=carina] [formats=pcm8,pcm16,pcm24,pcmu]
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { ulawDecodeSample } from "../../lib/audio.js";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const S = process.env.BANC_SORTIE || path.join(ICI, ".sorties", "fin-coupee");
fs.mkdirSync(S, { recursive: true });
const vault = fs.readFileSync(process.env.VAULT || "C:/Users/msi/.secrets/api-keys.env", "utf8");
const cle = (n) => (vault.match(new RegExp(`^${n}=(.*)$`, "m"))?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
const N = Number(process.argv[2] || 4);
const VOIX = process.argv[3] || "carina";
const FORMATS = (process.argv[4] || "pcm8,pcm16,pcm24,pcmu").split(",");
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const PHRASES = [
  { texte: "Très bien. C'est pour quel prénom ?", dernier: /pr[ée]nom/i },
  { texte: "Un conseiller vous rappellera à ce numéro. C'est bien ça, ou préférez-vous un autre numéro ?", dernier: /autre num[ée]ro/i },
  { texte: "Parfait, trois pizzas pour quarante-cinq euros. Vous la voulez pour quelle heure ?", dernier: /quelle heure/i },
  { texte: "Parfait, trois pizzas pour quarante-cinq euros, retrait à dix-neuf heures.", dernier: /dix-neuf heures|19 ?h/i },
];

const formatDe = (f) => f === "pcmu" ? { type: "audio/pcmu" } : { type: "audio/pcm", rate: Number(f.slice(3)) * 1000 };
const tauxDe = (f) => f === "pcmu" ? 8000 : Number(f.slice(3)) * 1000;
function versPcm(f, buf) {
  if (f !== "pcmu") return buf.subarray(0, buf.length - (buf.length % 2));
  const o = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) o.writeInt16LE(ulawDecodeSample(buf[i]), i * 2);
  return o;
}
function wav(pcm, taux) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(taux, 24); h.writeUInt32LE(taux * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const energieFin = (pcm, taux) => { const n = Math.round(taux * 0.15) * 2; let s = 0, k = 0; for (let i = Math.max(0, pcm.length - n); i + 1 < pcm.length; i += 2) { const v = pcm.readInt16LE(i); s += v * v; k++; } return k ? Math.round(Math.sqrt(s / k)) : 0; };
async function transcrire(fichier) {
  const fd = new FormData();
  fd.append("file", new Blob([fs.readFileSync(fichier)], { type: "audio/wav" }), "r.wav");
  fd.append("model", "gpt-4o-transcribe");
  fd.append("language", "fr");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${cle("OPENAI_API_KEY")}` }, body: fd });
  return r.ok ? ((await r.json()).text || "").trim() : `(erreur ${r.status})`;
}

async function session(f) {
  const tok = await fetch("https://api.x.ai/v1/realtime/client_secrets", { method: "POST", headers: { Authorization: `Bearer ${cle("XAI_API_KEY")}`, "Content-Type": "application/json" }, body: JSON.stringify({ expires_after: { seconds: 900 } }) }).then((r) => r.json());
  const ws = new WebSocket("wss://api.x.ai/v1/realtime?model=grok-voice-latest", [`xai-client-secret.${tok.value || tok.client_secret?.value}`]);
  await new Promise((ok) => { ws.onopen = ok; });
  let audio = [], texte = "", fini = false, pret = false;
  ws.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === "session.updated") pret = true;
    else if (e.type === "response.output_audio.delta") audio.push(Buffer.from(e.delta, "base64"));
    else if (e.type === "response.output_audio_transcript.delta") texte += e.delta || "";
    else if (e.type === "response.done") fini = true;
  };
  ws.send(JSON.stringify({ type: "session.update", session: {
    instructions: "Tu es Chiara, au téléphone chez Palazzo Pizza. Tu dis exactement les phrases demandées.",
    voice: VOIX, reasoning: { effort: "none" },
    audio: { input: { format: { type: "audio/pcm", rate: 8000 }, turn_detection: null }, output: { format: formatDe(f), speed: 1.1 } },
  } }));
  for (let i = 0; i < 80 && !pret; i++) await attendre(100);
  const lignes = [];
  for (let n = 0; n < N; n++) {
    for (const [ip, p] of PHRASES.entries()) {
      audio = []; texte = ""; fini = false;
      ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "(SYSTÈME : phrase suivante.)" }] } }));
      ws.send(JSON.stringify({ type: "response.create", response: { instructions: `Dis exactement cette phrase, mot pour mot, sans rien ajouter avant ni après : « ${p.texte} »` } }));
      for (let k = 0; k < 200 && !fini; k++) await attendre(50);
      const pcm = versPcm(f, Buffer.concat(audio));
      const taux = tauxDe(f);
      const fichier = path.join(S, `${f}-${VOIX}-p${ip + 1}-${n + 1}.wav`);
      fs.writeFileSync(fichier, wav(pcm, taux));
      lignes.push({ ip, n, fichier, duree: pcm.length / 2 / taux, energie: energieFin(pcm, taux), texteGrok: texte.trim() });
      await attendre(300);
    }
  }
  ws.close();
  await Promise.all(lignes.map(async (l) => { l.entendu = await transcrire(l.fichier); l.dernierEntendu = PHRASES[l.ip].dernier.test(l.entendu); }));
  return { f, lignes };
}

const resultats = await Promise.all(FORMATS.map(session));
for (const { f, lignes } of resultats) {
  console.log(`\n=== ${f} (voix ${VOIX})`);
  for (const [ip, p] of PHRASES.entries()) {
    const ls = lignes.filter((l) => l.ip === ip);
    const perdus = ls.filter((l) => !l.dernierEntendu).length, abruptes = ls.filter((l) => l.energie > 600).length, sansPoint = ls.filter((l) => !/[?.!…]\s*$/.test(l.texteGrok)).length;
    console.log(`  p${ip + 1} « ${p.texte.slice(-38)} » : dernier mot perdu ${perdus}/${ls.length}, fin abrupte ${abruptes}/${ls.length}, transcription Grok sans ponctuation finale ${sansPoint}/${ls.length}`);
    for (const l of ls.filter((x) => !x.dernierEntendu || x.energie > 600)) console.log(`      essai ${l.n + 1} : ${l.duree.toFixed(2)} s, énergie fin ${l.energie}, Grok « ${l.texteGrok.slice(-45)} », entendu « ${l.entendu.slice(-45)} »`);
  }
}
process.exit(0);
