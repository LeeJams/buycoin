const SENSITIVE_KEYS = [
  "access_key",
  "secret_key",
  "authorization",
  "api_key",
  "api_secret",
  "jwt",
  "bearer",
  "bithumb_access_key",
  "bithumb_secret_key",
];

function maskString(value) {
  if (typeof value !== "string") {
    return value;
  }

  if (value.length <= 6) {
    return "***";
  }

  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

export function maskSecrets(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(maskSecrets);
  }

  if (typeof value === "object") {
    const copy = {};
    for (const [key, inner] of Object.entries(value)) {
      if (SENSITIVE_KEYS.includes(key.toLowerCase())) {
        copy[key] = maskString(String(inner));
      } else {
        copy[key] = maskSecrets(inner);
      }
    }

    return copy;
  }

  return value;
}
