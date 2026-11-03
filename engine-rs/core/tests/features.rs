//! features.rs（ブラウザ版の入力作り）を Python の features.planes と照合する。
//! 照合データは okashi-narabe 直下で `python tools/gen-planes-fixtures.py runs/<run>/selfplay/genXXXX.npz` で作る。

use okashi_core::*;

#[test]
fn matches_python_planes() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/");
    let (Ok(st), Ok(pl)) = (std::fs::read(format!("{dir}planes_states.bin")), std::fs::read(format!("{dir}planes.bin"))) else {
        panic!("照合データがない：python tools/gen-planes-fixtures.py で作る");
    };
    let want: Vec<f32> = pl.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
    let n = st.len() / STATE_BYTES;
    assert_eq!(want.len(), n * PLANES_LEN);
    let mut out = vec![0f32; PLANES_LEN];
    for k in 0..n {
        planes(&st[k * STATE_BYTES..(k + 1) * STATE_BYTES], &mut out);
        for (i, (&a, &b)) in out.iter().zip(&want[k * PLANES_LEN..(k + 1) * PLANES_LEN]).enumerate() {
            assert!((a - b).abs() < 1e-6, "局面{k} チャンネル{} マス{}: Rust {a} / Python {b}", i / CELLS, i % CELLS);
        }
    }
    println!("{n}局面が一致");
}
