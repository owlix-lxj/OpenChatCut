/* ISAAC64 layout compatible with wx-video-channel-download (MIT, oliver 2026).
 * See third-party/wx-video-channel-download-LICENSE.txt. Only the first 128 KiB
 * of a Channels media file is XOR encoded. Keys must remain decimal strings.
 */
const u64 = (value: bigint) => BigInt.asUintN(64, value);

export function wechatKeyStream(decimalKey: string): Buffer {
  if (!/^\d{1,20}$/.test(decimalKey) || BigInt(decimalKey) > 0xffffffffffffffffn) throw new Error('视频号媒体密钥格式无效');
  const memory = Array<bigint>(256).fill(0n);
  const results = Array<bigint>(256).fill(0n);
  results[0] = BigInt(decimalKey);
  let a = 0n, b = 0n, c = 0n;
  let values = Array<bigint>(8).fill(0x9e3779b97f4a7c13n);
  const mix = () => {
    let [a, b, c, d, e, f, g, h] = values as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
    a = u64(a-e); f ^= h>>9n; h = u64(h+a);
    b = u64(b-f); g = u64(g^(a<<9n)); a = u64(a+b);
    c = u64(c-g); h ^= b>>23n; b = u64(b+c);
    d = u64(d-h); a = u64(a^(c<<15n)); c = u64(c+d);
    e = u64(e-a); b ^= d>>14n; d = u64(d+e);
    f = u64(f-b); c = u64(c^(e<<20n)); e = u64(e+f);
    g = u64(g-c); d ^= f>>17n; f = u64(f+g);
    h = u64(h-d); e = u64(e^(g<<14n)); g = u64(g+h);
    values = [a,b,c,d,e,f,g,h];
  };
  for (let i = 0; i < 4; i++) mix();
  for (const seed of [results, memory]) {
    for (let i = 0; i < 256; i += 8) {
      values = values.map((value, j) => u64(value + seed[i+j]!));
      mix();
      for (let j = 0; j < 8; j++) memory[i+j] = values[j]!;
    }
  }
  const output = Buffer.alloc(128 * 1024);
  for (let offset = 0; offset < output.length; offset += 2048) {
    c = u64(c+1n); b = u64(b+c);
    for (let i = 0; i < 256; i++) {
      const x = memory[i]!;
      if (i % 4 === 0) a = u64(~(a^(a<<21n)));
      else if (i % 4 === 1) a ^= a>>5n;
      else if (i % 4 === 2) a = u64(a^(a<<12n));
      else a ^= a>>33n;
      a = u64(a + memory[(i+128)%256]!);
      const y = u64(memory[Number((x>>3n)&255n)]! + a+b);
      memory[i] = y;
      b = u64(memory[Number((y>>11n)&255n)]! + x);
      results[i] = b;
    }
    for (let i = 0; i < 256; i++) output.writeBigUInt64BE(results[255-i]!, offset + i*8);
  }
  return output;
}
