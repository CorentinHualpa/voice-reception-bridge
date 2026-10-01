// Lecture par ElevenLabs : decoupage du texte de Grok en morceaux a synthetiser, configuration. Sans reseau.
// node test/lecture-eleven-test.mjs
import assert from "assert";
import { configLectureEleven, creerRognure, decouper, texteALire } from "../lib/lecture-eleven.js";
import { ulawEncodeSample } from "../lib/audio.js";
import { saluerSelonHeure } from "../lib/accueil.js";

let ok = 0;
const cas = (nom, fn) => { fn(); ok++; console.log("ok -", nom); };

// Rejoue une suite de morceaux de Grok (mesures du 28/09) et rend ce qui part a la synthese.
function rejouer(morceaux) {
  let tampon = "";
  const parts = [];
  const vider = (fin) => {
    for (;;) {
      const { part, reste } = decouper(tampon, { premier: parts.length === 0, fin });
      if (!part) break;
      parts.push(part.trim());
      tampon = reste;
    }
  };
  for (const m of morceaux) { tampon += m; vider(false); }
  vider(true);
  return parts;
}

cas("coupe sur les fins de phrase, et garde le reste pour la suite", () => {
  const parts = rejouer([
    "Bonjour ! Chez Palazzo, notre carte sans viande",
    " propose quatre délicieuses pizzas. Voici les ingrédients de chacune",
    " : - Fiorella : tomate, mozzarella et basilic frais. - Veggie : tomate",
    " et légumes grillés. Laquelle vous fait envie ? Je vous écoute !",
  ]);
  assert.equal(parts[0], "Bonjour !");
  assert.equal(parts[1], "Chez Palazzo, notre carte sans viande propose quatre délicieuses pizzas.");
  assert.ok(parts.every((p) => p.length > 0));
  assert.equal(parts.join(" ").replace(/\s+/g, " "), "Bonjour ! Chez Palazzo, notre carte sans viande propose quatre délicieuses pizzas. Voici les ingrédients de chacune : - Fiorella : tomate, mozzarella et basilic frais. - Veggie : tomate et légumes grillés. Laquelle vous fait envie ? Je vous écoute !");
});

cas("le premier morceau attend une proposition entiere, puis part au dernier mot entier si ca tarde", () => {
  // Trop court pour etre lu seul : on attend la suite (« Je… comprends » entendu le 01/10).
  assert.deepEqual(decouper("Je comprends", { premier: true }), { part: "", reste: "Je comprends" });
  assert.deepEqual(decouper("Bien sûr, c'est tout à fait", { premier: true }), { part: "", reste: "Bien sûr, c'est tout à fait" });
  // Une proposition assez longue part a sa virgule.
  assert.deepEqual(decouper("Je comprends tout à fait, mais il faudrait", { premier: true }), { part: "Je comprends tout à fait,", reste: " mais il faudrait" });
  // Passe le delai : on coupe au dernier mot ENTIER, la suite d'un mot entame attend.
  assert.deepEqual(decouper("Bien sûr, c'est tout à fai", { premier: true, presse: true }), { part: "Bien sûr, c'est tout à", reste: " fai" });
  assert.deepEqual(decouper("Je compr", { premier: true, presse: true }), { part: "", reste: "Je compr" });
  // Plus loin dans la reponse, une phrase inachevee attend la suite.
  assert.deepEqual(decouper(" Et à quelle heure", { premier: false }), { part: "", reste: " Et à quelle heure" });
});

cas("le texte d'OpenAI arrive par fragments de mots : jamais de mot coupe en deux", () => {
  const t = "Nous avons plusieurs pizzas sans viande que vous pouvez commander ce soi";
  assert.deepEqual(decouper(t, { premier: false }), { part: "Nous avons plusieurs pizzas sans viande que vous pouvez commander ce", reste: " soi" });
  assert.equal(decouper("Ça fait 4,50 euros pour le tiramisu et quatorze euros pour la Pacino ici", { premier: false }).part, "Ça fait 4,50 euros pour le tiramisu et quatorze euros pour la Pacino", "« 4,50 » n'est pas une virgule de phrase");
  // Rejoue d'un flux token par token : rien n'est perdu ni coupe dans un mot.
  const parts = rejouer(["Je", " compr", "ends", " tout", " à", " fait", ",", " mais", " il", " faud", "rait", " un", " poste", " séparé", "."]);
  assert.equal(parts[0], "Je comprends tout à fait,");
  assert.equal(parts.join(" "), "Je comprends tout à fait, mais il faudrait un poste séparé.");
});

cas("une longue phrase sans point se coupe a la derniere virgule", () => {
  const t = " Avec du jambon blanc, la Roma, la Regina et la Pacino, et avec du jambon de Parme la Rucola";
  const { part, reste } = decouper(t, { premier: false });
  assert.equal(part, " Avec du jambon blanc, la Roma, la Regina et la Pacino,");
  assert.equal(reste, " et avec du jambon de Parme la Rucola");
});

cas("a la fin, tout part", () => {
  assert.deepEqual(decouper(" ça vous arrangerait", { fin: true }), { part: " ça vous arrangerait", reste: "" });
  assert.deepEqual(decouper("   ", { fin: true }), { part: "", reste: "" });
});

cas("les guillemets fermants restent avec leur phrase", () => {
  assert.deepEqual(decouper("Dites « passe-moi Lorenzo ! » et", { premier: false }), { part: "Dites « passe-moi Lorenzo ! »", reste: " et" });
});

cas("les puces de liste deviennent une pause, les noms composes ne bougent pas", () => {
  assert.equal(texteALire("chacune : - Fiorella : tomate. - Veggie : tomate"), "chacune : Fiorella : tomate. Veggie : tomate");
  assert.equal(texteALire("- Regina"), "Regina");
  assert.equal(texteALire("Saint-Jean-de-Védas, passe-moi Lorenzo"), "Saint-Jean-de-Védas, passe-moi Lorenzo");
});

cas("configuration : coupee par defaut, et jamais a moitie", () => {
  assert.equal(configLectureEleven({}), null);
  assert.equal(configLectureEleven({ LECTURE: "grok" }), null);
  assert.equal(configLectureEleven({ LECTURE: "elevenlabs", ELEVEN_VOIX: "v" }), null, "sans cle, voix de Grok");
  assert.equal(configLectureEleven({ LECTURE: "elevenlabs", ELEVENLABS_API_KEY: "k" }), null, "sans voix, voix de Grok");
  const c = configLectureEleven({ LECTURE: "ElevenLabs", ELEVENLABS_API_KEY: "k", ELEVEN_VOIX: "v", ELEVEN_BALISE: " [warmly] " });
  assert.equal(c.modele, "eleven_v4_turbo");
  assert.equal(c.balise, "[warmly]");
  assert.equal(c.stabilite, 0.5);
});

// Un morceau synthetique : silence, voix (sinus), silence, en mu-law 8 kHz.
const silence = (ms) => Buffer.alloc(ms * 8, 0xff);
const voix = (ms) => Buffer.from(Array.from({ length: ms * 8 }, (_, i) => ulawEncodeSample(Math.round(5000 * Math.sin(i / 3)))));
function rogner(morceau, premier, pas = 160) {
  const r = creerRognure({ premier });
  const sortie = [];
  for (let o = 0; o < morceau.length; o += pas) sortie.push(...r.pousser(morceau.subarray(o, o + pas)));
  sortie.push(...r.finir());
  return Buffer.concat(sortie);
}

cas("les silences de bord sont rognes, la voix reste entiere", () => {
  const m = Buffer.concat([silence(200), voix(500), silence(300)]);
  const premier = rogner(m, true), suivant = rogner(m, false);
  assert.equal(premier.length / 8, 30 + 500 + 80, "premier morceau : 30 ms avant la voix, 80 ms apres");
  assert.equal(suivant.length / 8, 60 + 500 + 80, "morceau suivant : 60 ms avant la voix");
});

cas("une fin de phrase qui s'eteint doucement n'est pas mangee", () => {
  // La voix, puis 200 ms a faible niveau (le « -de » de « commande »), puis le vrai silence.
  const douce = Buffer.from(Array.from({ length: 1600 }, (_, i) => ulawEncodeSample(Math.round(250 * Math.sin(i / 3)))));
  const m = Buffer.concat([voix(400), douce, silence(300)]);
  assert.equal(rogner(m, false).length / 8, 400 + 200 + 80);
});

cas("un morceau sans voix detectable passe tel quel, sans rien retenir", () => {
  const m = silence(900);
  assert.equal(rogner(m, true).length, m.length);
  assert.equal(rogner(silence(100), false).length, 800);
});

cas("une voix longue part au fil de l'eau, seule la fin attend", () => {
  const r = creerRognure({ premier: false });
  let parti = 0;
  const m = Buffer.concat([silence(100), voix(2000)]);
  for (let o = 0; o < m.length; o += 400) for (const x of r.pousser(m.subarray(o, o + 400))) parti += x.length;
  assert.ok(parti >= (60 + 2000 - 500) * 8 - 400, `seuls les 500 derniers ms attendent (${parti / 8} ms partis)`);
});

cas("accueil : bonjour/bonsoir devient le bon mot selon l'heure de Paris", () => {
  const texte = "Palazzo pizza bonjour/bonsoir, qu'est-ce qui vous ferait plaisir ?";
  assert.equal(saluerSelonHeure(texte, new Date("2026-09-30T10:00:00Z")), "Palazzo pizza bonjour, qu'est-ce qui vous ferait plaisir ?");
  assert.equal(saluerSelonHeure(texte, new Date("2026-09-30T15:30:00Z")), "Palazzo pizza bonsoir, qu'est-ce qui vous ferait plaisir ?");
  assert.equal(saluerSelonHeure("Bonjour / bonsoir !", new Date("2026-09-30T18:00:00Z")), "Bonsoir !");
  assert.equal(saluerSelonHeure("Palazzo bonjour", new Date("2026-09-30T20:00:00Z")), "Palazzo bonjour", "un texte sans barre ne bouge pas");
  assert.equal(saluerSelonHeure("Palazzo pizza bonsoir/bonsoir, qu'est-ce", new Date("2026-09-30T20:30:00Z")), "Palazzo pizza bonsoir, qu'est-ce", "le doublon fabrique par DaleVoz");
});

console.log(`\n${ok} cas passes`);
