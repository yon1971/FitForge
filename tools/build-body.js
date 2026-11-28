/* Builds public/body-mesh.bin: one smooth anatomical body (signed-distance shapes blended together,
   meshed with surface nets), with every vertex labelled by the muscle group it belongs to.
   Run: NODE_PATH=/path/to/node_modules node tools/build-body.js   (needs the "isosurface" package) */
const iso = require('isosurface');
const fs = require('fs'), path = require('path');

const GROUPS = ['base', 'chest', 'shoulders', 'biceps', 'triceps', 'forearms', 'abs', 'obliques', 'traps', 'lats', 'lowerBack', 'glutes', 'quads', 'hamstrings', 'calves'];
const G = Object.fromEntries(GROUPS.map((g, i) => [g, i]));

// ---------- SDF primitives ----------
const len = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
function rotM(rx = 0, ry = 0, rz = 0) { // inverse rotation matrix (world -> local), XYZ order
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  // R = Rz*Ry*Rx ; inverse = transpose
  const R = [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx]];
  return [[R[0][0], R[1][0], R[2][0]], [R[0][1], R[1][1], R[2][1]], [R[0][2], R[1][2], R[2][2]]];
}
function ellipsoid(c, r, rot) { const M = rot ? rotM(...rot) : null;
  return (x, y, z) => { let px = x - c[0], py = y - c[1], pz = z - c[2];
    if (M) { const a = M[0][0] * px + M[0][1] * py + M[0][2] * pz, b = M[1][0] * px + M[1][1] * py + M[1][2] * pz, d = M[2][0] * px + M[2][1] * py + M[2][2] * pz; px = a; py = b; pz = d; }
    const k0 = len(px / r[0], py / r[1], pz / r[2]), k1 = len(px / (r[0] * r[0]), py / (r[1] * r[1]), pz / (r[2] * r[2]));
    return k1 === 0 ? -Math.min(...r) : k0 * (k0 - 1) / k1; }; }
// capsule with different radii at each end (iq round cone)
function roundCone(a, b, r1, r2) {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2], l2 = bax * bax + bay * bay + baz * baz, rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  return (x, y, z) => {
    const pax = x - a[0], pay = y - a[1], paz = z - a[2];
    const yv = pax * bax + pay * bay + paz * baz, zv = yv - l2;
    const xx = Math.pow(pax * l2 - bax * yv, 2) + Math.pow(pay * l2 - bay * yv, 2) + Math.pow(paz * l2 - baz * yv, 2);
    const y2 = yv * yv * l2, z2 = zv * zv * l2, k = Math.sign(rr) * rr * rr * xx;
    if (Math.sign(zv) * a2 * z2 > k) return Math.sqrt(xx + z2) * il2 - r2;
    if (Math.sign(yv) * a2 * y2 < k) return Math.sqrt(xx + y2) * il2 - r1;
    return (Math.sqrt(xx * a2 * il2) + yv * rr) * il2 - r1;
  };
}
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };

// ---------- the body ----------
const P = []; // {f, g, k}
const base = (f, k = 0.05) => P.push({ f, g: G.base, k });
const mus = (g, f, k = 0.022) => P.push({ f, g: G[g], k });

// head & neck  (about 8 heads tall)
base(ellipsoid([0, 1.625, 0.0], [0.125, 0.165, 0.145]), 0.03);                // cranium
base(ellipsoid([0, 1.53, 0.035], [0.098, 0.1, 0.105], [0.25, 0, 0]), 0.06);     // jaw / chin
base(ellipsoid([0, 1.585, 0.14], [0.02, 0.04, 0.025], [0.35, 0, 0]), 0.02);    // nose
for (const s of [1, -1]) {
  base(ellipsoid([s * 0.123, 1.6, -0.005], [0.022, 0.045, 0.03]), 0.02);       // ears
  base(ellipsoid([s * 0.045, 1.64, 0.12], [0.03, 0.016, 0.02]), 0.02);         // brow
}
base(roundCone([0, 1.3, -0.015], [0, 1.5, 0.0], 0.072, 0.062), 0.06);
// torso
base(ellipsoid([0, 1.215, -0.01], [0.235, 0.08, 0.12]), 0.08);   // shoulder girdle
base(ellipsoid([0, 1.04, 0.0], [0.205, 0.235, 0.14]), 0.08);     // rib cage
base(ellipsoid([0, 0.73, 0.0], [0.165, 0.2, 0.118]), 0.1);       // waist
base(ellipsoid([0, 0.5, 0.01], [0.18, 0.13, 0.12]), 0.08);       // lower belly
base(ellipsoid([0, 0.33, -0.005], [0.205, 0.135, 0.13]), 0.08);  // pelvis
for (const s of [1, -1]) {
  // arms (relaxed A-pose; fingertips reach mid-thigh)
  const sh = [s * 0.275, 1.19, -0.01], el = [s * 0.36, 0.66, -0.035], wr = [s * 0.425, 0.2, 0.02];
  base(ellipsoid(sh, [0.075, 0.075, 0.075]), 0.05);
  base(roundCone(sh, el, 0.062, 0.046), 0.04);
  base(roundCone(el, wr, 0.05, 0.032), 0.03);
  base(ellipsoid([s * 0.44, 0.09, 0.03], [0.03, 0.09, 0.05], [0, 0, s * 0.1]), 0.035);    // hand
  base(ellipsoid([s * 0.445, 0.115, 0.075], [0.016, 0.045, 0.016], [0.25, 0, s * 0.25]), 0.02); // thumb
  // legs
  const hp = [s * 0.105, 0.3, 0], kn = [s * 0.125, -0.5, 0.01], an = [s * 0.14, -1.29, -0.015];
  base(roundCone(hp, kn, 0.118, 0.066), 0.08);
  base(roundCone(kn, an, 0.064, 0.038), 0.045);
  base(ellipsoid([s * 0.126, -0.5, 0.055], [0.045, 0.045, 0.028]), 0.03);   // kneecap
  base(ellipsoid([s * 0.148, -1.37, 0.055], [0.045, 0.04, 0.115], [0.1, 0, 0]), 0.045);   // foot
  base(ellipsoid([s * 0.14, -1.34, -0.035], [0.035, 0.045, 0.04]), 0.03);   // heel

  // ---- muscles (sit on / just above the surface so they shape it) ----
  mus('chest', ellipsoid([s * 0.1, 1.1, 0.105], [0.115, 0.08, 0.058], [0, s * 0.2, s * -0.12]));
  mus('shoulders', ellipsoid([s * 0.29, 1.15, 0.0], [0.08, 0.11, 0.088], [0, 0, s * 0.22]));
  mus('biceps', ellipsoid([s * 0.322, 0.93, 0.035], [0.047, 0.15, 0.048], [0, 0, s * 0.17]));
  mus('triceps', ellipsoid([s * 0.318, 0.96, -0.045], [0.05, 0.16, 0.05], [0, 0, s * 0.17]));
  mus('forearms', ellipsoid([s * 0.38, 0.53, 0.0], [0.05, 0.15, 0.046], [0, 0, s * 0.15]));
  for (const [y, w] of [[0.9, 0.042], [0.795, 0.044], [0.69, 0.044]]) mus('abs', ellipsoid([s * 0.047, y, 0.112], [w, 0.047, 0.03]), 0.012);
  mus('abs', ellipsoid([s * 0.044, 0.565, 0.11], [0.042, 0.07, 0.028]), 0.012);
  mus('obliques', ellipsoid([s * 0.145, 0.69, 0.05], [0.055, 0.14, 0.078], [0, s * 0.3, s * -0.08]));
  mus('traps', ellipsoid([s * 0.1, 1.29, -0.035], [0.11, 0.06, 0.06], [0, 0, s * -0.35]));
  mus('lats', ellipsoid([s * 0.135, 0.96, -0.09], [0.095, 0.19, 0.06], [0, s * -0.25, s * 0.28]));
  mus('lowerBack', ellipsoid([s * 0.04, 0.6, -0.105], [0.038, 0.14, 0.04]), 0.015);
  mus('glutes', ellipsoid([s * 0.095, 0.27, -0.1], [0.11, 0.12, 0.09], [0, s * 0.2, 0]));
  mus('quads', ellipsoid([s * 0.118, 0.0, 0.045], [0.088, 0.24, 0.072], [0, 0, s * -0.04]));
  mus('quads', ellipsoid([s * 0.085, -0.33, 0.055], [0.045, 0.1, 0.045], [0, 0, s * -0.2]), 0.02);   // teardrop
  mus('hamstrings', ellipsoid([s * 0.118, 0.0, -0.05], [0.078, 0.23, 0.062], [0, 0, s * -0.04]));
  mus('calves', ellipsoid([s * 0.134, -0.74, -0.04], [0.058, 0.14, 0.05]));
  mus('calves', ellipsoid([s * 0.138, -0.76, 0.035], [0.032, 0.14, 0.032]), 0.02);   // shin
}
mus('traps', ellipsoid([0, 1.16, -0.11], [0.075, 0.14, 0.038]));

// ---------- sample ----------
function field(x, y, z) {
  let d = 1e9;
  for (const p of P) { const v = p.f(x, y, z); d = d === 1e9 ? v : smin(d, v, p.k); }
  return d;
}
const B = [[-0.56, -1.47, -0.25], [0.56, 1.83, 0.25]];
const H = +(process.env.RES || 0.0105);
const dims = B[0].map((lo, i) => Math.ceil((B[1][i] - lo) / H));
console.time('mesh');
const m = iso.surfaceNets(dims, field, B);
console.timeEnd('mesh');
let pos = m.positions, cells = m.cells;
console.log('verts', pos.length, 'tris', cells.length);

// Taubin smoothing (keeps volume, removes voxel steps)
const nb = pos.map(() => new Set());
for (const [a, b, c] of cells) { nb[a].add(b).add(c); nb[b].add(a).add(c); nb[c].add(a).add(b); }
const nbA = nb.map(s => [...s]);
function smoothStep(lam) {
  const next = pos.map((p, i) => { const n = nbA[i]; if (!n.length) return p; let x = 0, y = 0, z = 0; for (const j of n) { x += pos[j][0]; y += pos[j][1]; z += pos[j][2]; }
    x /= n.length; y /= n.length; z /= n.length; return [p[0] + lam * (x - p[0]), p[1] + lam * (y - p[1]), p[2] + lam * (z - p[2])]; });
  pos = next;
}
for (let i = 0; i < 6; i++) { smoothStep(0.5); smoothStep(-0.53); }

// label each vertex: the muscle it lies on and how strongly (soft edges)
const grp = new Uint8Array(pos.length), wgt = new Float32Array(pos.length);
const ss = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
pos.forEach(([x, y, z], i) => {
  let best = 0, g = 0;
  for (const p of P) { if (!p.g) continue; const w = ss(0.022, -0.004, p.f(x, y, z)); if (w > best) { best = w; g = p.g; } }
  grp[i] = g; wgt[i] = best;
});
// blur weights a little along the surface, keep the group of the strongest neighbour
for (let it = 0; it < 3; it++) {
  const w0 = wgt.slice(), g0 = grp.slice();
  for (let i = 0; i < pos.length; i++) {
    let sum = w0[i], n = 1, bg = g0[i], bw = w0[i];
    for (const j of nbA[i]) { const wj = g0[j] === g0[i] || !w0[i] ? w0[j] : 0; sum += wj; n++; if (w0[j] > bw + 0.25) { bw = w0[j]; bg = g0[j]; } }
    wgt[i] = sum / n; if (!w0[i] || bg !== g0[i] && bw > w0[i] + 0.25) grp[i] = bg;
  }
}
const wq = Uint8Array.from(wgt, w => Math.round(Math.min(1, w) * 255));
for (let i = 0; i < pos.length; i++) if (wq[i] < 8) grp[i] = 0;

// ---------- write: magic, nV, nT, bounds(6 f32), positions (u16 quantised), indices (u16/u32), groups (u8) ----------
const nV = pos.length, nT = cells.length, big = nV > 65535;
const lo = [0, 1, 2].map(k => Math.min(...pos.map(p => p[k]))), hi = [0, 1, 2].map(k => Math.max(...pos.map(p => p[k])));
const head = Buffer.alloc(4 + 4 + 4 + 24);
head.write('FFB2', 0); head.writeUInt32LE(nV, 4); head.writeUInt32LE(nT, 8);
[...lo, ...hi].forEach((v, i) => head.writeFloatLE(v, 12 + i * 4));
const q = new Uint16Array(nV * 3);
pos.forEach((p, i) => { for (let k = 0; k < 3; k++) q[i * 3 + k] = Math.round((p[k] - lo[k]) / (hi[k] - lo[k]) * 65535); });
const idx = big ? new Uint32Array(nT * 3) : new Uint16Array(nT * 3);
cells.forEach((c, i) => { idx[i * 3] = c[0]; idx[i * 3 + 1] = c[1]; idx[i * 3 + 2] = c[2]; });
const out = Buffer.concat([head, Buffer.from(q.buffer), Buffer.from(idx.buffer), Buffer.from(grp.buffer), Buffer.from(wq.buffer)]);
const file = path.join(__dirname, '..', 'public', 'body-mesh.bin');
fs.writeFileSync(file, out);
const counts = {}; grp.forEach(g => counts[GROUPS[g]] = (counts[GROUPS[g]] || 0) + 1);
console.log('wrote', file, (out.length / 1024).toFixed(0) + ' KB', big ? 'u32' : 'u16', counts);
