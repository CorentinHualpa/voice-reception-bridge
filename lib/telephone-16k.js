// Passage du 8 kHz TÉLÉPHONIQUE au 16 kHz que Smart Turn attend.
//
// C'est le point le plus risqué du chantier, et il n'est documenté nulle part : le modèle est entraîné en
// 16 kHz large bande, alors qu'une ligne téléphonique ne porte rien au-dessus de ~3,4 kHz. Les bandes mel
// supérieures seront donc quasi vides quoi qu'on fasse, et aucun banc public ne dit ce que le modèle en pense.
// Pipecat l'utilise ainsi en production sur son transport Twilio, mais sans publier de mesure en 8 kHz.
//
// Ce qu'on peut au moins garantir, c'est de ne pas AJOUTER d'artefact : un simple doublement d'échantillons
// (ou une interpolation linéaire) crée une image du spectre entre 4 et 8 kHz, c'est-à-dire exactement du
// contenu inventé dans les bandes hautes que le modèle va regarder. On interpole donc proprement : insertion
// de zéros puis filtre passe-bas à 4 kHz, ce qui laisse les bandes hautes VIDES plutôt que fausses.
//
// Filtre : RIF à phase linéaire, 31 coefficients, sinus cardinal fenêtré par Hamming, coupure à 0,25 de la
// fréquence d'échantillonnage de sortie (soit 4 kHz à 16 kHz). Gain 2 pour compenser l'insertion de zéros.

const TAPS = 31;
const COUPURE = 0.25; // fraction de la fréquence d'échantillonnage de SORTIE

const FILTRE = (() => {
  const h = new Float32Array(TAPS);
  const centre = (TAPS - 1) / 2;
  let somme = 0;
  for (let i = 0; i < TAPS; i++) {
    const n = i - centre;
    const sinc = n === 0 ? 2 * COUPURE : Math.sin(2 * Math.PI * COUPURE * n) / (Math.PI * n);
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (TAPS - 1));
    h[i] = sinc * hamming;
    somme += h[i];
  }
  // Normalisation à gain unité en continu, puis × 2 pour l'insertion de zéros.
  for (let i = 0; i < TAPS; i++) h[i] = (h[i] / somme) * 2;
  return h;
})();

/**
 * PCM16 8 kHz -> Float32 16 kHz normalisé dans [-1, 1], prêt pour Smart Turn.
 * `queue` porte les derniers échantillons de l'appel précédent pour que le filtre ne reparte pas de zéro
 * à chaque paquet : sans elle, on entend un clic tous les 20 ms et le spectre en garde la trace.
 */
export function pcm8kVers16k(pcm16, queue = null) {
  const n = pcm16.length / 2;
  const doublee = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) doublee[i * 2] = pcm16.readInt16LE(i * 2) / 32768; // zéros aux positions impaires
  const avant = queue && queue.length ? queue : new Float32Array(TAPS - 1);
  const source = new Float32Array(avant.length + doublee.length);
  source.set(avant, 0);
  source.set(doublee, avant.length);
  const sortie = new Float32Array(doublee.length);
  for (let i = 0; i < doublee.length; i++) {
    let acc = 0;
    for (let k = 0; k < TAPS; k++) {
      const j = i + avant.length - k;
      if (j >= 0 && j < source.length) acc += FILTRE[k] * source[j];
    }
    sortie[i] = acc;
  }
  return { pcm: sortie, queue: source.subarray(source.length - (TAPS - 1)).slice() };
}

/** Anneau de N secondes à 16 kHz : ce que le modèle regarde au moment de décider. */
export function creerAnneau(secondes = 8) {
  const taille = secondes * 16000;
  const buf = new Float32Array(taille);
  let ecrit = 0;
  return {
    pousser(bloc) {
      if (bloc.length >= taille) { buf.set(bloc.subarray(bloc.length - taille)); ecrit = taille; return; }
      const reste = taille - (ecrit % taille);
      if (bloc.length <= reste) buf.set(bloc, ecrit % taille);
      else { buf.set(bloc.subarray(0, reste), ecrit % taille); buf.set(bloc.subarray(reste), 0); }
      ecrit += bloc.length;
    },
    /** Les `taille` derniers échantillons, dans l'ordre chronologique. */
    lire() {
      if (ecrit < taille) return buf.subarray(0, ecrit).slice();
      const pos = ecrit % taille;
      const out = new Float32Array(taille);
      out.set(buf.subarray(pos), 0);
      out.set(buf.subarray(0, pos), taille - pos);
      return out;
    },
    vider() { buf.fill(0); ecrit = 0; },
  };
}
