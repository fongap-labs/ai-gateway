export function cryptoRng(): number {
  const buf = crypto.getRandomValues(new Uint32Array(1));
  const random = buf[0] ?? 0;
  return random * 2 ** -32;
}
