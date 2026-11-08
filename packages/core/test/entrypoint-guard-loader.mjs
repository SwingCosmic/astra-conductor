/** A fresh Node process uses this guard to prove the business entrypoint never loads Hono. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "hono" || specifier.startsWith("hono/"))
    throw new Error(`Core main entrypoint loaded the optional HTTP dependency: ${specifier}`);
  return nextResolve(specifier, context);
}
