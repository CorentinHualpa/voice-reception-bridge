// Harnais de test "sur le fond" du pont vocal Grok, SANS audio.
// Un client simule (OpenAI gpt-4o-mini) telephone a Dany (Grok Voice realtime, en mode texte).
// On capte le dialogue tour par tour et on le sauvegarde pour evaluation.
//
// Usage : node test/grok-test.cjs            (tous les personas)
//         node test/grok-test.cjs devis-pompe  (un seul)
//
// Cle XAI + OPENAI lues dans le vault, jamais affichees.

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const VAULT = "C:/Users/msi/.secrets/api-keys.env";
const vault = fs.readFileSync(VAULT, "utf8");
const getKey = (k) => { const m = vault.match(new RegExp("^" + k + "=(.*)$", "m")); return m ? m[1].trim() : ""; };
const XAI_API_KEY = getKey("XAI_API_KEY");
const OPENAI_API_KEY = getKey("OPENAI_API_KEY");
const GROK_MODEL = "grok-voice-latest";

// === Prompt teste : PROMPT_FILE si fourni, sinon le prompt generique d'origine du pont ===
const DEFAULT_PROMPT = `Tu es Dany, l'assistant vocal telephonique de Motralec (distribution de pompes et moteurs electriques). Tu decroches quand le standard est ferme (hors horaires). Tu vouvoies, tu es chaleureux, calme et clair, une idee par phrase, une seule question a la fois.

Tu fais le tri :
- Question simple que tu connais (horaires, adresse, services) : tu reponds directement, tu ne demandes aucune coordonnee.
- Vrai besoin (devis, SAV, suivi, demande de rappel) : tu qualifies puis tu transmets pour rappel. Tu captes, dans l'ordre, une info a la fois : le besoin precis, puis le nom et le prenom, puis l'adresse email (demandee une seule fois, sans epeler), puis la ville. Le numero de telephone est deja connu (le numero appelant).

Tu confirmes a voix haute les marques, references et noms (pieges phonetiques). Tu ne donnes jamais de prix, de delai ferme ni de disponibilite ; tu dis qu'un conseiller confirmera. Tu n'inventes jamais une information.

A la fin, tu dis une phrase de cloture ("toute l'equipe vous remercie, un conseiller vous rappellera, bonne journee") et tu laisses la personne raccrocher. Tu n'envoies aucun mail toi-meme : le recap part automatiquement.

Reponds toujours en francais.`;

const RECEPTION_PROMPT = process.env.PROMPT_FILE && fs.existsSync(process.env.PROMPT_FILE)
  ? fs.readFileSync(process.env.PROMPT_FILE, "utf8")
  : DEFAULT_PROMPT;

const PERSONAS = [
  { id: "devis-pompe", brief: "Tu t'appelles Marc Lefebvre. Tu appelles pour un devis sur une pompe immergee pour ton forage de jardin. Ton email est marc.lefebvre@gmail.com, tu habites Etrechy. Tu donnes tes infos au fur et a mesure qu'on te les demande. Tu es cooperatif et poli." },
  { id: "horaires", brief: "Tu veux juste connaitre les horaires d'ouverture de l'agence Motralec d'Herblay. Tu ne veux PAS laisser de coordonnees ni de rappel, juste l'info. Si on insiste pour tes coordonnees, tu refuses gentiment et tu redemandes juste les horaires." },
  { id: "sav-panne", brief: "Tu t'appelles Sophie Garnier. Ta pompe de relevage est tombee en panne ce soir, c'est urgent, tu veux qu'un technicien te rappelle vite. Ton email est sophie.garnier@wanadoo.fr, tu es a Sevres. Tu es un peu stressee." },
  { id: "prix-grundfos", brief: "Tu t'appelles Jean-Pierre Dubois. Tu veux connaitre le PRIX d'une pompe de surface Grundfos, tu insistes une ou deux fois pour avoir un prix ou une fourchette. Ton email est jp.dubois@orange.fr, tu habites Massy. Si on ne te donne pas de prix, tu finis par accepter un rappel." },
  { id: "presse", brief: "Tu es tres presse et un peu sec. Tu veux juste qu'on te rappelle pour un projet de surpresseur pour un immeuble. Tu donnes le strict minimum, tu reponds en quelques mots, tu n'aimes pas les longues questions. Ton nom : Karim Benali, email karim.benali@free.fr, a Etrechy." },
  { id: "horaires-etrechy", brief: "Tu veux connaitre l'adresse ET les horaires d'ouverture de l'agence Motralec d'Etrechy (91). Tu ne laisses aucune coordonnee, tu veux juste l'info." },
  { id: "dn-suivi", brief: "Tu suis un devis en cours, le devis DN360, et tu veux savoir ou ca en est et etre rappele. Tu t'appelles Paul Mercier, email paul.mercier@gmail.com, tu es a Herblay. Tu donnes le numero de devis quand on te le demande." },
  { id: "anglais", brief: "You ONLY speak English and you do not understand French at all. You are calling to ask: do you sell Grundfos pumps, and can someone call you back about a quote? Keep replying in English the whole time, even if the agent answers in French." },
];

const CALLER_SYS = (persona) => `Tu joues un client qui telephone a Motralec (distributeur de pompes et moteurs electriques), un soir hors horaires d'ouverture. Tu tombes sur Dany, l'assistant vocal.
PERSONA: ${persona.brief}
REGLES:
- Tu reponds en francais, phrases courtes et naturelles comme a l'oral au telephone. UNE information a la fois.
- Tu ne joues QUE le client. Tu n'ecris jamais a la place de Dany.
- Tu reagis a ce que Dany vient de dire (s'il pose une question, tu y reponds ; s'il demande ton nom, tu donnes ton nom ; etc.).
- Reste realiste : un vrai client ne deballe pas tout d'un coup.
- Des que Dany prononce sa phrase de cloture (il te remercie et te souhaite une bonne journee ou bonne soiree), tu raccroches en repondant UNIQUEMENT [RACCROCHE], rien d'autre.
- Ne mets jamais de guillemets autour de tes repliques.`;

function mintToken() {
  return fetch("https://api.x.ai/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${XAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expires_after: { seconds: 600 } }),
  }).then((r) => r.json()).then((t) => t.value || t.secret || t.token || (t.client_secret && t.client_secret.value));
}

async function callerTurn(persona, dialog) {
  const messages = [{ role: "system", content: CALLER_SYS(persona) }];
  for (const t of dialog) messages.push({ role: t.who === "Agent" ? "user" : "assistant", content: t.msg });
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 25000);
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0.7, messages }),
      signal: ac.signal,
    }).then((r) => r.json());
    if (!r.choices) { console.error("[caller] reponse OpenAI inattendue:", JSON.stringify(r).slice(0, 300)); return "[RACCROCHE]"; }
    return (r.choices[0].message.content || "").trim();
  } catch (e) {
    console.error("[caller] OpenAI KO:", e.message);
    return "[RACCROCHE]";
  } finally { clearTimeout(to); }
}

function runConversation(persona, maxTurns = 10) {
  return new Promise(async (resolve) => {
    const dialog = [];
    let finished = false;
    let grok = null;
    const finish = () => { if (finished) return; finished = true; try { grok && grok.close(); } catch {} resolve(dialog); };
    const hardTimer = setTimeout(() => { console.error(`  [timeout conversation ${persona.id}]`); finish(); }, 90000);
    let token;
    try { token = await mintToken(); } catch (e) { console.error("[grok] token KO", e.message); clearTimeout(hardTimer); return finish(); }
    if (!token) { console.error("[grok] pas de token"); clearTimeout(hardTimer); return finish(); }

    grok = new WebSocket(`wss://api.x.ai/v1/realtime?model=${GROK_MODEL}`, [`xai-client-secret.${token}`]);
    let sessReady = null, turnResolve = null, turnBuf = "";

    grok.on("open", () => {
      grok.send(JSON.stringify({
        type: "session.update",
        session: {
          instructions: RECEPTION_PROMPT,
          voice: "eve",
          turn_detection: { type: "server_vad", threshold: 0.6 },
          input_audio_transcription: { language: "fr" },
          audio: { input: { format: { type: "audio/pcm", rate: 24000 } }, output: { format: { type: "audio/pcm", rate: 24000 } } },
        },
      }));
    });

    grok.on("message", (raw) => {
      let e; try { e = JSON.parse(raw.toString()); } catch { return; }
      switch (e.type) {
        case "ping": grok.send(JSON.stringify({ type: "pong", ...(e.event_id ? { event_id: e.event_id } : {}) })); break;
        case "session.updated": if (sessReady) { const f = sessReady; sessReady = null; f(); } break;
        case "response.output_audio_transcript.delta": if (e.delta) turnBuf += e.delta; break;
        case "response.output_text.delta": if (e.delta) turnBuf += e.delta; break;
        case "response.done": if (turnResolve) { const r = turnResolve; turnResolve = null; const t = turnBuf.trim(); turnBuf = ""; r(t); } break;
        case "error": console.error(`  [grok error ${persona.id}]`, JSON.stringify(e.error || e).slice(0, 200)); break;
      }
    });
    grok.on("error", (err) => { console.error(`  [grok ws ${persona.id}]`, err.message); if (turnResolve) { const r = turnResolve; turnResolve = null; r(turnBuf.trim() || "(grok error)"); } });
    grok.on("close", () => { if (turnResolve) { const r = turnResolve; turnResolve = null; r(turnBuf.trim() || "(ws fermee)"); } });

    function grokTurn() {
      return new Promise((res) => {
        turnResolve = res; turnBuf = "";
        // Timeout pose AVANT le send : meme si grok.send throw (WS coupee), le tour se resout, pas de hang.
        setTimeout(() => { if (turnResolve) { turnResolve = null; res(turnBuf.trim() || "(pas de reponse)"); } }, 30000);
        try { grok.send(JSON.stringify({ type: "response.create" })); }
        catch (e) { if (turnResolve) { turnResolve = null; res("(erreur envoi grok)"); } }
      });
    }
    function sendUser(text) {
      try { grok.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } })); }
      catch (e) { console.error(`  [grok send ${persona.id}]`, e.message); }
    }

    await new Promise((res) => { sessReady = res; setTimeout(res, 8000); });

    // Salutation d'ouverture (Dany parle en premier)
    const greet = await grokTurn();
    dialog.push({ who: "Agent", msg: greet });
    console.log(`  Dany: ${greet}`);

    for (let i = 0; i < maxTurns && !finished; i++) {
      const clientMsg = await callerTurn(persona, dialog);
      if (finished) break;
      if (!clientMsg || /\[RACCROCHE\]/i.test(clientMsg)) { console.log("  [client raccroche]"); break; }
      dialog.push({ who: "Client", msg: clientMsg });
      console.log(`  Client: ${clientMsg}`);
      sendUser(clientMsg);
      const danyMsg = await grokTurn();
      if (finished) break;
      dialog.push({ who: "Agent", msg: danyMsg });
      console.log(`  Dany: ${danyMsg}`);
    }

    clearTimeout(hardTimer);
    finish();
  });
}

(async () => {
  if (!XAI_API_KEY || !OPENAI_API_KEY) { console.error("Cle manquante (XAI/OPENAI)"); process.exit(1); }
  const only = process.argv[2];
  const list = only ? PERSONAS.filter((p) => p.id === only) : PERSONAS;
  const outDir = path.join(__dirname, "results", process.env.RESULTS_LABEL || "baseline");
  fs.mkdirSync(outDir, { recursive: true });
  const summary = [];
  for (const persona of list) {
    console.log(`\n===== ${persona.id} =====`);
    const dialog = await runConversation(persona);
    const text = dialog.map((l) => `${l.who} : ${l.msg}`).join("\n");
    fs.writeFileSync(path.join(outDir, `${persona.id}.txt`), text, "utf8");
    summary.push({ id: persona.id, turns: dialog.length, dialog });
    console.log(`  -> ${dialog.length} tours sauvegardes`);
  }
  fs.writeFileSync(path.join(outDir, "_summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(`\n[OK] ${summary.length} conversations dans ${outDir}`);
})();
