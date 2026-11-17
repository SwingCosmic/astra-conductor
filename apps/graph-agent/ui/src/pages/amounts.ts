// Quoted prices are nonnegative decimal strings, possibly longer than double precision.
export function compareAmount(a: string, b: string) {
  const [ai, af = ""] = a.replace(/^0+(?=\d)/, "").split("."),
    [bi, bf = ""] = b.replace(/^0+(?=\d)/, "").split(".");
  if (ai!.length !== bi!.length) return ai!.length - bi!.length;
  if (ai !== bi) return ai! < bi! ? -1 : 1;
  const size = Math.max(af.length, bf.length),
    av = af.padEnd(size, "0"),
    bv = bf.padEnd(size, "0");
  return av === bv ? 0 : av < bv ? -1 : 1;
}
