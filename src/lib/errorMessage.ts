/** `err.message` de um erro desconhecido (`catch (err)`), ou undefined se não houver — mesmo comportamento de `err?.message`. */
export function errorMessage(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "message" in err) {
    const m = (err as { message?: unknown }).message;
    return typeof m === "string" ? m : undefined;
  }
  return undefined;
}
