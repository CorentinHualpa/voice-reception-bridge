// Lecture par ElevenLabs : decoupage du texte de Grok en morceaux a synthetiser, configuration. Sans reseau.
// node test/lecture-eleven-test.mjs
import assert from "assert";
import { configLectureEleven, decouper, texteALire } from "../lib/lecture-eleven.js";

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

cas("le premier morceau part sans attendre la fin de phrase, mais jamais minuscule", () => {
  assert.deepEqual(decouper("Bien sûr, c'est tout à fait", { premier: true }), { part: "Bien sûr, c'est tout à fait", reste: "" });
  assert.deepEqual(decouper("Bien sûr", { premier: true }), { part: "", reste: "Bien sûr" });
  // Plus loin dans la reponse, une phrase inachevee attend la suite.
  assert.deepEqual(decouper(" Et à quelle heure", { premier: false }), { part: "", reste: " Et à quelle heure" });
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

console.log(`\n${ok} cas passes`);
