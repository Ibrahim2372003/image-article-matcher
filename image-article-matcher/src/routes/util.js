/** Express 4 does not catch rejected promises from async handlers; this forwards them to the error middleware. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export const badRequest = (res, message) => res.status(400).json({ error: "invalid_input", message });
export const notFound = (res, message) => res.status(404).json({ error: "not_found", message });
