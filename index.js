/* ============================================================
   CABO – Multiplayer-Server (Node.js + Socket.io)
   Hält den kompletten Spielzustand. Spieler sehen nur, was sie
   sehen dürfen (Anti-Cheat by Design).
   ============================================================ */

const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3001;
// Erlaubte Frontend-Adressen (Komma-getrennt in Env-Variable, sonst alles erlauben)
const ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim())
  : "*";

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Cabo-Server laeuft.");
});

const io = new Server(httpServer, { cors: { origin: ORIGINS } });

/* ---------- Spiellogik (identisch zur Artifact-Version) ---------- */

const actionOf = (v) =>
  v === 7 || v === 8 ? "PEEK" : v === 9 || v === 10 ? "SPY" : v === 11 || v === 12 ? "SWAP" : null;

let uidCounter = 0;
const uid = () =>
  `c${Date.now().toString(36)}${(uidCounter++).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

function buildDeck() {
  const vals = [0, 0];
  for (let v = 1; v <= 12; v++) for (let i = 0; i < 4; i++) vals.push(v);
  vals.push(13, 13);
  for (let i = vals.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [vals[i], vals[j]] = [vals[j], vals[i]];
  }
  return vals.map((v) => ({ id: uid(), v }));
}

function freshGame(code, startPlayer = 0) {
  const deck = buildDeck();
  return {
    code,
    status: "waiting", // waiting → setup → playing → finished
    players: [], // {name, ready, socketId}
    hands: [deck.splice(0, 4), deck.splice(0, 4)],
    deck,
    discard: [deck.shift()],
    turn: startPlayer,
    caboCaller: null,
    drawn: null, // { card, from }
    log: [],
    result: null,
    wins: [0, 0],
  };
}

function scoreGame(g) {
  const sums = g.hands.map((h) => h.reduce((a, c) => a + c.v, 0));
  const kami = g.hands.map(
    (h) => h.length === 4 && h.map((c) => c.v).sort((a, b) => a - b).join(",") === "12,12,13,13"
  );
  let winner, points = [0, 0], note = "";
  if (kami[0] !== kami[1]) {
    winner = kami[0] ? 0 : 1;
    points[1 - winner] = 50;
    note = "Kamikaze! (12, 12, 13, 13)";
  } else {
    if (sums[0] === sums[1]) {
      winner = g.caboCaller !== null ? g.caboCaller : 0;
      note = "Gleichstand – der Cabo-Ansager gewinnt.";
    } else {
      winner = sums[0] < sums[1] ? 0 : 1;
    }
    const loser = 1 - winner;
    points[loser] = sums[loser];
    if (g.caboCaller === loser) {
      points[loser] += 5;
      note = "Cabo verfehlt: +5 Strafpunkte.";
    }
  }
  return { winner, sums, points, kami, note };
}

/* ---------- Räume ---------- */

const games = new Map(); // code -> game

function makeCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
  } while (games.has(code));
  return code;
}

/* Zustand für einen bestimmten Spieler "zensieren" */
function viewFor(g, seat) {
  return {
    code: g.code,
    status: g.status,
    players: g.players.map((p) => ({ name: p.name, ready: p.ready, online: !!p.socketId })),
    hands: g.hands.map((h, i) =>
      h.map((c) => (g.status === "finished" ? { id: c.id, v: c.v } : { id: c.id }))
    ),
    deckCount: g.deck.length,
    discardTop: g.discard.length ? g.discard[g.discard.length - 1] : null,
    turn: g.turn,
    caboCaller: g.caboCaller,
    drawn: g.drawn
      ? g.drawn.from === "discard" || g.turn === seat
        ? { card: g.drawn.card, from: g.drawn.from }
        : { held: true, from: g.drawn.from }
      : null,
    log: g.log.slice(-6),
    result: g.result,
    wins: g.wins,
    seat,
  };
}

function broadcast(g) {
  g.players.forEach((p, seat) => {
    if (p.socketId) io.to(p.socketId).emit("state", viewFor(g, seat));
  });
}

function endTurn(g, extraLog) {
  if (extraLog) g.log.push(extraLog);
  g.drawn = null;
  const next = 1 - g.turn;
  if (g.caboCaller !== null && next === g.caboCaller) {
    g.status = "finished";
    g.result = scoreGame(g);
    g.wins[g.result.winner] += 1;
    g.log.push(`Spielende! ${g.players[g.result.winner].name} gewinnt.`);
  } else {
    g.turn = next;
  }
}

const myCard = (g, seat, id) => g.hands[seat].find((c) => c.id === id);

/* Allen Spielern zeigen, WELCHE Karten betroffen sind (ohne Werte zu verraten) */
function fx(g, type, cardIds, by) {
  g.players.forEach((p) => p.socketId && io.to(p.socketId).emit("effect", { type, cardIds, by }));
}

/* ---------- Socket-Handler ---------- */

io.on("connection", (socket) => {
  let myCode = null;
  let mySeat = null;

  const game = () => games.get(myCode);
  const isMyTurn = (g) => g && g.status === "playing" && g.turn === mySeat;

  socket.on("create", ({ name }, cb) => {
    if (!name || !name.trim()) return cb({ error: "Bitte einen Namen angeben." });
    const code = makeCode();
    const g = freshGame(code);
    g.players.push({ name: name.trim().slice(0, 16), ready: false, socketId: socket.id });
    g.log.push(`${name.trim()} hat das Spiel eröffnet.`);
    games.set(code, g);
    myCode = code; mySeat = 0;
    cb({ ok: true });
    broadcast(g);
  });

  socket.on("join", ({ name, code }, cb) => {
    code = (code || "").trim().toUpperCase();
    const g = games.get(code);
    if (!g) return cb({ error: `Kein Spiel mit Code ${code} gefunden.` });
    // Wiederbeitritt nach Verbindungsabbruch (gleicher Name, Platz frei)
    const ghost = g.players.findIndex((p) => !p.socketId && p.name === (name || "").trim().slice(0, 16));
    if (ghost !== -1) {
      g.players[ghost].socketId = socket.id;
      myCode = code; mySeat = ghost;
      cb({ ok: true });
      g.log.push(`${g.players[ghost].name} ist wieder da.`);
      broadcast(g);
      return;
    }
    if (g.players.length >= 2) return cb({ error: "Dieses Spiel ist bereits voll." });
    if (!name || !name.trim()) return cb({ error: "Bitte einen Namen angeben." });
    g.players.push({ name: name.trim().slice(0, 16), ready: false, socketId: socket.id });
    g.status = "setup";
    g.log.push(`${name.trim()} ist beigetreten. Seht euch je 2 eigene Karten an!`);
    myCode = code; mySeat = 1;
    cb({ ok: true });
    broadcast(g);
  });

  /* Startphase: 2 eigene Karten ansehen */
  socket.on("setupPeek", ({ cardIds }, cb) => {
    const g = game();
    if (!g || g.status !== "setup" || g.players[mySeat].ready) return;
    if (!Array.isArray(cardIds) || cardIds.length !== 2) return cb({ error: "Genau 2 Karten wählen." });
    const cards = cardIds.map((id) => myCard(g, mySeat, id)).filter(Boolean);
    if (cards.length !== 2) return cb({ error: "Ungültige Karten." });
    cb({ reveal: cards.map((c) => ({ id: c.id, v: c.v })) });
  });

  socket.on("ready", () => {
    const g = game();
    if (!g || g.status !== "setup") return;
    g.players[mySeat].ready = true;
    if (g.players.length === 2 && g.players.every((p) => p.ready)) {
      g.status = "playing";
      g.log.push(`Beide bereit – ${g.players[g.turn].name} beginnt!`);
    }
    broadcast(g);
  });

  /* Zug: ziehen */
  socket.on("drawDeck", () => {
    const g = game();
    if (!isMyTurn(g) || g.drawn) return;
    if (g.deck.length === 0) {
      const top = g.discard.pop();
      g.deck = g.discard;
      for (let i = g.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [g.deck[i], g.deck[j]] = [g.deck[j], g.deck[i]];
      }
      g.discard = [top];
      g.log.push("Ablagestapel wurde neu gemischt.");
    }
    g.drawn = { card: g.deck.shift(), from: "deck" };
    g.log.push(`${g.players[mySeat].name} zieht vom Nachziehstapel.`);
    broadcast(g);
  });

  socket.on("takeDiscard", () => {
    const g = game();
    if (!isMyTurn(g) || g.drawn || g.discard.length === 0) return;
    const card = g.discard.pop();
    g.drawn = { card, from: "discard" };
    g.log.push(`${g.players[mySeat].name} nimmt die ${card.v} vom Ablagestapel.`);
    broadcast(g);
  });

  socket.on("discardDrawn", () => {
    const g = game();
    if (!isMyTurn(g) || !g.drawn || g.drawn.from !== "deck") return;
    g.discard.push(g.drawn.card);
    endTurn(g, `${g.players[mySeat].name} wirft die ${g.drawn.card.v} ab.`);
    broadcast(g);
  });

  /* Tausch: 1 Karte oder Duett/Triplett/Quartett */
  socket.on("swap", ({ cardIds }) => {
    const g = game();
    if (!isMyTurn(g) || !g.drawn) return;
    if (!Array.isArray(cardIds) || cardIds.length === 0 || cardIds.length > 4) return;
    const hand = g.hands[mySeat];
    const picked = cardIds.map((id) => myCard(g, mySeat, id)).filter(Boolean);
    if (picked.length !== cardIds.length) return;
    const drawnCard = g.drawn.card;
    if (picked.length > 1 && new Set(picked.map((c) => c.v)).size > 1) {
      // Fehlversuch: Karten allen zeigen, bleiben liegen, Zug verloren
      g.discard.push(drawnCard);
      io.to(g.code).emit("publicReveal", picked.map((c) => ({ id: c.id, v: c.v })));
      g.players.forEach((p) => p.socketId &&
        io.to(p.socketId).emit("publicReveal", picked.map((c) => ({ id: c.id, v: c.v }))));
      endTurn(g, `${g.players[mySeat].name} versucht ${picked.length} Karten zu tauschen – Fehlversuch (${picked.map((c) => c.v).join(", ")})! Zug verloren.`);
    } else {
      const firstIdx = hand.findIndex((c) => c.id === picked[0].id);
      g.hands[mySeat] = hand.filter((c) => !cardIds.includes(c.id));
      g.hands[mySeat].splice(Math.min(firstIdx, g.hands[mySeat].length), 0, drawnCard);
      g.discard.push(...picked);
      fx(g, "NEU", [drawnCard.id], mySeat);
      const label = picked.length === 1 ? "1 Karte" : `${picked.length} Karten (${picked.map((c) => c.v).join(", ")})`;
      endTurn(g, `${g.players[mySeat].name} tauscht ${label} gegen die gezogene Karte.`);
    }
    broadcast(g);
  });

  /* Aktionskarten – nur direkt nach Ziehen vom Nachziehstapel */
  const canAct = (g, want) =>
    isMyTurn(g) && g.drawn && g.drawn.from === "deck" && actionOf(g.drawn.card.v) === want;

  socket.on("actionPeek", ({ cardId }, cb) => {
    const g = game();
    if (!canAct(g, "PEEK")) return;
    const c = myCard(g, mySeat, cardId);
    if (!c) return;
    cb({ reveal: [{ id: c.id, v: c.v }] });
    fx(g, "PEEK", [c.id], mySeat);
    g.discard.push(g.drawn.card);
    endTurn(g, `${g.players[mySeat].name} nutzt PEEK und sieht sich eine eigene Karte an.`);
    broadcast(g);
  });

  socket.on("actionSpy", ({ cardId }, cb) => {
    const g = game();
    if (!canAct(g, "SPY")) return;
    const c = g.hands[1 - mySeat].find((x) => x.id === cardId);
    if (!c) return;
    cb({ reveal: [{ id: c.id, v: c.v }] });
    fx(g, "SPY", [c.id], mySeat);
    g.discard.push(g.drawn.card);
    endTurn(g, `${g.players[mySeat].name} nutzt SPY und sieht sich eine Karte von ${g.players[1 - mySeat].name} an.`);
    broadcast(g);
  });

  socket.on("actionSwap", ({ ownId, oppId }) => {
    const g = game();
    if (!canAct(g, "SWAP")) return;
    const myIdx = g.hands[mySeat].findIndex((c) => c.id === ownId);
    const opIdx = g.hands[1 - mySeat].findIndex((c) => c.id === oppId);
    if (myIdx === -1 || opIdx === -1) return;
    const tmp = g.hands[mySeat][myIdx];
    g.hands[mySeat][myIdx] = g.hands[1 - mySeat][opIdx];
    g.hands[1 - mySeat][opIdx] = tmp;
    fx(g, "SWAP", [g.hands[mySeat][myIdx].id, g.hands[1 - mySeat][opIdx].id], mySeat);
    g.discard.push(g.drawn.card);
    endTurn(g, `${g.players[mySeat].name} nutzt SWAP und tauscht blind eine Karte mit ${g.players[1 - mySeat].name}.`);
    broadcast(g);
  });

  socket.on("cabo", () => {
    const g = game();
    if (!isMyTurn(g) || g.drawn || g.caboCaller !== null) return;
    g.caboCaller = mySeat;
    endTurn(g, `${g.players[mySeat].name} sagt CABO an! ${g.players[1 - mySeat].name} hat noch einen Zug.`);
    broadcast(g);
  });

  socket.on("rematch", () => {
    const g = game();
    if (!g || g.status !== "finished") return;
    const fresh = freshGame(g.code, g.result.winner);
    fresh.players = g.players.map((p) => ({ ...p, ready: false }));
    fresh.status = "setup";
    fresh.wins = g.wins;
    fresh.log = [`Neue Partie! ${fresh.players[fresh.turn].name} beginnt (Gewinner der letzten Runde).`];
    games.set(g.code, fresh);
    broadcast(fresh);
  });

  socket.on("disconnect", () => {
    const g = game();
    if (!g) return;
    if (g.players[mySeat]) {
      g.players[mySeat].socketId = null;
      g.log.push(`${g.players[mySeat].name} hat die Verbindung verloren.`);
      broadcast(g);
    }
    // Verwaiste Spiele nach 2 Stunden aufräumen
    setTimeout(() => {
      const cur = games.get(myCode);
      if (cur && cur.players.every((p) => !p.socketId)) games.delete(myCode);
    }, 2 * 60 * 60 * 1000);
  });
});

httpServer.listen(PORT, () => console.log(`Cabo-Server läuft auf Port ${PORT}`));
