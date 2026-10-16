// 三人将棋のルール（サーバー用）。shogi3 の game.js（allMoves・applyMove）、ui.js（nextTurn・resignHuman）と同じ中身を、
// 盤の様子を引数で受けとる形に書きなおしたもの。ブラウザ版と同じになっていることは server/shogi-check.js で確かめる
//   局面 st：{board, hand, elim, turn, moves, rule, over, winner, winType, out, log}
//     board[r][c] は {p, o, pr} か null。p は FU KY KE GIN KIN KAKU HI OU、o は席（0 青・1 赤・2 緑）、pr は成り
//     hand[o] は持ち駒の配列。elim[o] は脱落。moves は指した手の数。out は脱落した順の席
//     rule は取った駒のゆくえ：'all' 常に持ち駒 / 'next' お裾分け（残りのもう1人へ） / 'off' 条件をみたさなければ消える
//     winType は 'king'（最後の1人）/ 'try'（入玉）/ 'limit'（500手）。log は棋譜（shogi3 の「棋譜をコピー」の moves と同じ形）
//   手 mv：{fr, fc, tr, tc, pro} か {drop:true, piece, tr, tc}
// 青は下から上、赤は上から下、緑は右から左へ進む
export const MAX_MOVES = 500;
export const RULES = ['all', 'next', 'off'];
const PV = { FU: 100, KY: 300, KE: 350, GIN: 400, KIN: 500, KAKU: 800, HI: 900, OU: 10000000 };
const PVP = { FU: 400, KY: 200, KE: 150, GIN: 100, KAKU: 500, HI: 450 };
const HAND_RATE = 1.3;
const CAN_PRO = ['FU', 'KY', 'KE', 'GIN', 'KAKU', 'HI'];

const inB = (r, c) => r >= 0 && r < 9 && c >= 0 && c < 9;
// 各席の前の向きに合わせて回す
const rotDir = (dr, dc, o) => (o === 0 ? [dr, dc] : o === 1 ? [-dr, -dc] : [-dc, dr]);
export const nextAlive = (elim, cur) => { for (let i = 1; i <= 3; i++) { const n = (cur + i) % 3; if (!elim[n]) return n; } return -1; };

export function newState(rule = 'all') {
  const board = Array.from({ length: 9 }, () => Array(9).fill(null));
  const put = (r, c, p, o) => { board[r][c] = { p, o, pr: false }; };
  [[8, 0, 'GIN'], [8, 1, 'KIN'], [8, 2, 'OU'], [8, 3, 'KIN'], [8, 4, 'GIN'], [7, 0, 'HI'], [7, 4, 'KAKU']].forEach(([r, c, p]) => put(r, c, p, 0));
  for (let c = 0; c <= 4; c++) put(6, c, 'FU', 0);
  [[0, 0, 'GIN'], [0, 1, 'KIN'], [0, 2, 'OU'], [0, 3, 'KIN'], [0, 4, 'GIN'], [1, 0, 'KAKU'], [1, 4, 'HI']].forEach(([r, c, p]) => put(r, c, p, 1));
  for (let c = 0; c <= 4; c++) put(2, c, 'FU', 1);
  [[2, 8, 'GIN'], [3, 8, 'KIN'], [4, 8, 'OU'], [5, 8, 'KIN'], [6, 8, 'GIN'], [2, 7, 'HI'], [6, 7, 'KAKU']].forEach(([r, c, p]) => put(r, c, p, 2));
  for (let r = 2; r <= 6; r++) put(r, 6, 'FU', 2);
  return { board, hand: [['KY', 'KE'], ['KY', 'KE'], ['KY', 'KE']], elim: [false, false, false], turn: 0, moves: 0,
    rule: RULES.includes(rule) ? rule : 'all', over: false, winner: -1, winType: null, out: [], log: [] };
}

// 駒が動けるマス（自分の駒のあるマスには行けない。玉を取られる手かどうかは見ない）
function rawMoves(bd, r, c) {
  const cell = bd[r][c]; if (!cell) return [];
  const { p, o, pr } = cell, res = [];
  const step = (dr, dc) => { const [a, b] = rotDir(dr, dc, o), nr = r + a, nc = c + b; if (inB(nr, nc) && bd[nr][nc]?.o !== o) res.push([nr, nc]); };
  const slide = (dr, dc) => {
    let nr = r + dr, nc = c + dc;
    while (inB(nr, nc)) { if (bd[nr][nc]?.o === o) break; res.push([nr, nc]); if (bd[nr][nc]) break; nr += dr; nc += dc; }
  };
  if (pr && ['FU', 'KY', 'KE', 'GIN'].includes(p)) { [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0]].forEach(([a, b]) => step(a, b)); return res; }
  switch (p) {
    case 'FU': step(-1, 0); break;
    case 'KY': { const [a, b] = rotDir(-1, 0, o); slide(a, b); break; }
    case 'KE': [[-2, -1], [-2, 1]].forEach(([a, b]) => step(a, b)); break;
    case 'GIN': [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 1]].forEach(([a, b]) => step(a, b)); break;
    case 'KIN': [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0]].forEach(([a, b]) => step(a, b)); break;
    case 'HI': [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([a, b]) => slide(a, b)); if (pr) [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([a, b]) => step(a, b)); break;
    case 'KAKU': [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([a, b]) => slide(a, b)); if (pr) [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([a, b]) => step(a, b)); break;
    case 'OU': for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (a || b) step(a, b); break;
  }
  return res;
}
const inPromoZone = (o, r, c) => (o === 0 ? r <= 2 : o === 1 ? r >= 6 : c <= 2);
function mustPromote(p, o, tr, tc) {
  if (p === 'FU' || p === 'KY') return o === 0 ? tr === 0 : o === 1 ? tr === 8 : tc === 0;
  if (p === 'KE') return o === 0 ? tr <= 1 : o === 1 ? tr >= 7 : tc <= 1;
  return false;
}

// その席が指せる手のぜんぶ
export function legalMoves(st, o) {
  if (st.over || st.elim[o]) return [];
  const bd = st.board, res = [];
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    const cell = bd[r][c]; if (!cell || cell.o !== o) continue;
    for (const [tr, tc] of rawMoves(bd, r, c)) {
      const canPro = !cell.pr && CAN_PRO.includes(cell.p);
      const base = { fr: r, fc: c, tr, tc };
      if (canPro && (inPromoZone(o, r, c) || inPromoZone(o, tr, tc))) {
        if (mustPromote(cell.p, o, tr, tc)) res.push({ ...base, pro: true });
        else res.push({ ...base, pro: false }, { ...base, pro: true });
      } else res.push({ ...base, pro: false });
    }
  }
  for (const piece of new Set(st.hand[o])) {
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
      if (bd[r][c]) continue;
      if ((piece === 'KY' || piece === 'KE' || piece === 'FU') && mustPromote(piece, o, r, c)) continue;
      if (piece === 'FU') { // 二歩：青・赤は同じ筋、緑は同じ段に、成っていない自分の歩があれば打てない
        let nifu = false;
        for (let k = 0; k < 9 && !nifu; k++) { const x = o === 2 ? bd[r][k] : bd[k][c]; if (x?.o === o && x.p === 'FU' && !x.pr) nifu = true; }
        if (nifu) continue;
      }
      res.push({ drop: true, piece, tr: r, tc: c });
    }
  }
  return res;
}
// 送られてきた手を、指せる手の中から探す（形がおかしい手は null）
export function findMove(st, o, mv) {
  if (!mv || typeof mv !== 'object') return null;
  return legalMoves(st, o).find((m) => (m.drop
    ? mv.drop === true && mv.piece === m.piece && mv.tr === m.tr && mv.tc === m.tc
    : !mv.drop && mv.fr === m.fr && mv.fc === m.fc && mv.tr === m.tr && mv.tc === m.tc && !!mv.pro === m.pro)) || null;
}

function findKing(bd, o) { for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) if (bd[r][c]?.p === 'OU' && bd[r][c].o === o) return [r, c]; return [-1, -1]; }
function countPieces(st, o) { let n = st.hand[o].length; for (const row of st.board) for (const x of row) if (x?.o === o) n++; return n; }
// 消滅ありのとき、取った駒を持ち駒にできるか（だれかが脱落した・成り駒・取られた側の玉が真ん中より前・取られた側が3枚以上多い）
function canKeep(st, att, vic, cap) {
  if (st.rule === 'all') return true;
  if (st.rule === 'next') return false;
  if (st.elim.some(Boolean)) return true;
  if (cap.pr) return true;
  const [kr, kc] = findKing(st.board, vic);
  if (kr !== -1 && (vic === 0 ? kr <= 4 : vic === 1 ? kr >= 4 : kc <= 4)) return true;
  return countPieces(st, vic) - countPieces(st, att) >= 3;
}
// 脱落していないほかの席の駒が、そのマスに利いているか
function attacked(st, r, c, o) {
  for (let er = 0; er < 9; er++) for (let ec = 0; ec < 9; ec++) {
    const x = st.board[er][ec];
    if (!x || x.o === o || st.elim[x.o]) continue;
    if (rawMoves(st.board, er, ec).some(([a, b]) => a === r && b === c)) return true;
  }
  return false;
}
// 駒の価値の合計（500手のときの順位。持ち駒は1.3倍）
export function scores(st) {
  const s = [0, 0, 0];
  for (const row of st.board) for (const x of row) if (x && x.p !== 'OU') s[x.o] += PV[x.p] + (x.pr ? PVP[x.p] || 0 : 0);
  st.hand.forEach((h, o) => h.forEach((p) => { s[o] += PV[p] * HAND_RATE; }));
  return s;
}
const end = (st, winner, winType) => { st.over = true; st.winner = winner; st.winType = winType; };

// 次の番へ。指せる手のない人はとばす（ブラウザ版の「手がありません（スキップ）」）
function advance(st) {
  let n = st.turn;
  for (let i = 0; i < 3; i++) {
    n = nextAlive(st.elim, n);
    if (n < 0) return;
    if (legalMoves(st, n).length) { st.turn = n; return; }
  }
  st.turn = n; // だれも指せない（ふつうは起きない）
}

const clone = (st) => structuredClone(st);
// 1手指す。mv は findMove で見つけた手。新しい局面を返す
export function play(st0, o, mv) {
  const st = clone(st0);
  st.log.push({ o, mv: mv.drop ? { drop: true, piece: mv.piece, tr: mv.tr, tc: mv.tc } : { fr: mv.fr, fc: mv.fc, tr: mv.tr, tc: mv.tc, pro: !!mv.pro } });
  st.moves++;
  // 500手：手は盤に置かず、駒の価値で勝ちを決める（ブラウザ版と同じ）
  if (st.moves >= MAX_MOVES) {
    const s = scores(st), alive = [0, 1, 2].filter((i) => !st.elim[i]);
    end(st, alive.reduce((a, b) => (s[a] >= s[b] ? a : b)), 'limit');
    return st;
  }
  const bd = st.board;
  if (mv.drop) {
    st.hand[o].splice(st.hand[o].indexOf(mv.piece), 1);
    bd[mv.tr][mv.tc] = { p: mv.piece, o, pr: false };
    advance(st); return st;
  }
  const cell = bd[mv.fr][mv.fc], cap = bd[mv.tr][mv.tc];
  const moveIt = () => { bd[mv.tr][mv.tc] = { p: cell.p, o, pr: !!(mv.pro || cell.pr) }; bd[mv.fr][mv.fc] = null; };
  if (cap?.p === 'OU') { // 玉を取った：取られた人は脱落。残り1人なら勝ち
    moveIt(); st.elim[cap.o] = true; st.out.push(cap.o);
    if (st.elim.filter((e) => !e).length <= 1) end(st, o, 'king'); else advance(st);
    return st;
  }
  if (cap) { // 取った駒のゆくえ（canKeep は駒を動かす前の盤で数える。ブラウザ版と同じ）
    if (st.rule === 'next') {
      const others = [0, 1, 2].filter((p) => !st.elim[p] && p !== o && p !== cap.o);
      st.hand[others.length ? others[0] : o].push(cap.p);
    } else if (st.elim[cap.o] || canKeep(st, o, cap.o, cap)) st.hand[o].push(cap.p);
  }
  moveIt();
  // 入玉：玉が敵陣の1段目に入り、そのマスにほかの人の利きがなければ勝ち
  if (cell.p === 'OU' && (o === 0 ? mv.tr <= 0 : o === 1 ? mv.tr >= 8 : mv.tc <= 0) && !attacked(st, mv.tr, mv.tc, o)) {
    end(st, o, 'try'); return st;
  }
  advance(st); return st;
}

// 投了：玉を盤から取りのぞいて脱落（ほかの駒は動かないまま残る）
export function resign(st0, o) {
  const st = clone(st0);
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) if (st.board[r][c]?.o === o && st.board[r][c].p === 'OU') st.board[r][c] = null;
  st.elim[o] = true; st.out.push(o); st.log.push({ o, resign: true });
  const alive = [0, 1, 2].filter((i) => !st.elim[i]);
  if (alive.length <= 1) end(st, alive[0] ?? -1, 'king');
  else if (st.turn === o) advance(st);
  return st;
}

// 順位：勝った人が1位、あとは脱落が遅い順（500手のときは駒の価値の順）
export function ranking(st) {
  if (!st.over) return null;
  const rest = [0, 1, 2].filter((i) => i !== st.winner && !st.out.includes(i));
  const s = scores(st);
  rest.sort((a, b) => s[b] - s[a]);
  return [st.winner, ...rest, ...st.out.slice().reverse().filter((i) => i !== st.winner)];
}
