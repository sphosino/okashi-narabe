// ブラウザだけで動く学習AI（サーバーなし。三人将棋の web/ai.js と同じ形）。
// 探索・ルール・入力作りは WebAssembly（engine-rs/wasm）、ネットの推論は ONNX Runtime Web（WebGPU、使えなければ CPU）。
// 使い方：await OkashiAI.init();
//         const a = await OkashiAI.think(cfg, st, { hand });  // a は rules.js の手（R.actions の1つ）
// 1局を「1局制のセット」として読む（勝ちボーナス1点、a=0。1位になることだけを目指す）。
(function (global) {
  "use strict";
  const STATE_BYTES = 196, ROOT_BYTES = 200, PLANES = 45 * 81, NUM_POLICY = 19 * 81 + 2;
  const ITEMS = ["arrow", "dog", "rain", "dove"];

  // 使う重み。ページの URL に ?ai=r3-gen0016 のように付けると、web/models/ の別の重みを使う（手元で試すとき）
  const q = new URLSearchParams(global.location ? global.location.search : "").get("ai");
  const DEFAULT_MODEL = "web/models/" + (q && /^[\w-]+$/.test(q) ? q : "r3-gen0066") + ".onnx";

  const OkashiAI = {
    ready: false,
    provider: null,
    visits: 1000,
    batch: 16,

    // ルールの部分だけ（Node での照合にも使う）
    async initWasm(bytes) {
      const { instance } = await WebAssembly.instantiate(bytes, {});
      this.w = instance.exports;
    },

    async init(opt) {
      const o = Object.assign({ model: DEFAULT_MODEL, wasm: "web/okashi_wasm.wasm" }, opt || {});
      await this.initWasm(await (await fetch(o.wasm)).arrayBuffer());
      const ort = global.ort;
      ort.env.wasm.wasmPaths = o.ortWasmPaths || "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
      // GPU が本当に使えるかを先に確かめる（ONNX Runtime Web 1.30.0 では、WebGPU で作るのに失敗すると CPU でも作れなくなるため）
      let gpuOk = false;
      // WebGPU ではこのネットの出力が壊れる（2026-11-04、ONNX Runtime Web 1.30.0。PyTorch との差が 7〜9。CPU なら 1e-6）。?gpu を付けたときだけ試す
      const tryGpu = o.gpu ?? new URLSearchParams(global.location ? global.location.search : "").has("gpu");
      if ("gpu" in navigator && tryGpu && !o.forceCpu) {
        try { gpuOk = !!(await navigator.gpu.requestAdapter()); } catch (e) { gpuOk = false; }
      }
      let lastErr = null;
      for (const p of gpuOk ? ["webgpu", "wasm"] : ["wasm"]) {
        try { this.sess = await ort.InferenceSession.create(o.model, { executionProviders: [p] }); this.provider = p; break; }
        catch (e) { lastErr = e; }
      }
      if (!this.sess) throw lastErr || new Error("ネットを読み込めませんでした");
      this.model = o.model.split("/").pop().replace(/\.onnx$/, "");
      if (this.provider === "wasm") { this.visits = o.cpuVisits || 200; this.batch = 8; }
      else { this.visits = o.visits || 1000; this.batch = 16; }
      // 準備運転（最初の推論は遅いので、ここで済ませておく）
      for (const n of [1, this.batch]) await this.sess.run({ planes: new ort.Tensor("float32", new Float32Array(n * PLANES), [n, 45, 9, 9]) });
      this.ready = true;
      return this.provider;
    },

    // rules.js の状態 → 根の局面 200 バイト（engine-rs/core/src/set.rs の encode ＋ わいわいの種）
    //   opt.hand：手持ちの元の数。opt.bonus：勝ちボーナス（1局制なので、同点のときだけ効く）
    encode(cfg, st, opt) {
      const o = Object.assign({ hand: 6, bonus: 1 }, opt || {});
      const s = new Uint8Array(ROOT_BYTES), n = cfg.size;
      for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
        const v = r < n && c < n ? st.cells[r * n + c] : 4;
        s[r * 9 + c] = v === null ? 3 : v;
      }
      for (const i of st.fixed) s[81 + Math.floor(i / n) * 9 + (i % n)] = 1;
      for (let p = 0; p < 3; p++) {
        s[162 + p] = Math.max(0, Math.min(255, st.hands[p]));
        s[165 + p] = Math.max(0, Math.min(255, st.scores[p]));
        s[183 + p] = st.items && st.items[p] ? ITEMS.indexOf(st.items[p]) + 1 : 0;
      }
      s[174] = st.turn;
      s[175] = st.moves & 255; s[176] = (st.moves >> 8) & 255;
      s[177] = n; s[178] = cfg.need; s[179] = cfg.target; s[180] = cfg.loveBonus ? 1 : 0;
      s[181] = Math.min(255, cfg.maxMoves ?? 150); s[182] = cfg.party ? 1 : 0;
      if (st.box) { s[186] = Math.floor(st.box.at / n) * 9 + (st.box.at % n); s[187] = ITEMS.indexOf(st.box.k) + 1; }
      else s[186] = 255;
      s[188] = 1; s[189] = 0; s[190] = o.bonus; s[194] = o.hand;
      const seed = (st.seed || 0) >>> 0;
      s[196] = seed & 255; s[197] = (seed >>> 8) & 255; s[198] = (seed >>> 16) & 255; s[199] = seed >>> 24;
      return s;
    },

    newSearch(root, visits, batch) {
      const w = this.w, p = w.alloc(ROOT_BYTES);
      new Uint8Array(w.memory.buffer, p, ROOT_BYTES).set(root);
      const ctx = w.search_new(p, visits, batch, 1.5);
      w.dealloc(p, ROOT_BYTES);
      return ctx;
    },

    // 読んで、rules.js の actions(cfg, st, st.turn) の中から1手を返す。res に読みの結果（訪問数・勝率の見込み）も置く
    async think(cfg, st, opt) {
      const o = opt || {}, w = this.w, ort = global.ort, t0 = performance.now();
      const ctx = this.newSearch(this.encode(cfg, st, o), o.visits || this.visits, this.batch);
      let bufP = 0, bufR = 0, cap = 0;
      try {
        for (;;) {
          const k = w.search_next(ctx);
          if (k === 0) break;
          const x = new Float32Array(w.memory.buffer, w.search_planes_ptr(ctx), k * PLANES).slice();
          const out = await this.sess.run({ planes: new ort.Tensor("float32", x, [k, 45, 9, 9]) });
          const pol = out.policy.data, rank = out.rank.data;
          // 書き込み用の領域（足りなければ取り直す。取り直すとメモリが増えて古い view は使えなくなるので、毎回 view を作る）
          if (k > cap) {
            if (cap) { w.dealloc(bufP, cap * NUM_POLICY * 4); w.dealloc(bufR, cap * 36); }
            cap = k; bufP = w.alloc(cap * NUM_POLICY * 4); bufR = w.alloc(cap * 36);
          }
          new Float32Array(w.memory.buffer, bufP, k * NUM_POLICY).set(pol);
          new Float32Array(w.memory.buffer, bufR, k * 9).set(rank);
          w.search_submit(ctx, bufP, bufR);
          if (o.timeMs > 0 && performance.now() - t0 >= o.timeMs) break;
        }
        const n = w.search_result(ctx);
        const visits = Array.from(new Uint32Array(w.memory.buffer, w.search_visits_ptr(ctx), n));
        const value = Array.from(new Float32Array(w.memory.buffer, w.search_value_ptr(ctx), 3));
        let best = 0;
        for (let i = 1; i < n; i++) if (visits[i] > visits[best]) best = i;
        const acts = global.Okashi.actions(cfg, st, st.turn);
        if (acts.length !== n) throw new Error(`合法手の数が合わない（rules.js ${acts.length} / wasm ${n}）`);
        this.last = { visits, value, ms: Math.round(performance.now() - t0), total: visits.reduce((a, b) => a + b, 0) };
        return acts[best];
      } finally {
        if (cap) { w.dealloc(bufP, cap * NUM_POLICY * 4); w.dealloc(bufR, cap * 36); }
        w.search_free(ctx);
      }
    },
  };

  if (typeof module === "object" && module.exports) module.exports = OkashiAI;
  else global.OkashiAI = OkashiAI;
})(typeof window !== "undefined" ? window : globalThis);
