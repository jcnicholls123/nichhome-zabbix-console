const SECRET_KEYS = /pass|password|token|auth|session|key|secret/i;

export function sanitize(value) {
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SECRET_KEYS.test(key))
      .map(([key, item]) => [key, sanitize(item)])
  );
}

export function text(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value).replace(/[<>]/g, "");
}
