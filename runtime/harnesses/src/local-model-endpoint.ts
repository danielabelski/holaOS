const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  "::1",
  "host.docker.internal",
]);

const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;

export function withDefaultHttpScheme(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed || URL_SCHEME_PATTERN.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

function endpointHostname(baseUrl: string): string | null {
  const candidate = withDefaultHttpScheme(baseUrl);
  if (!candidate) {
    return null;
  }
  try {
    const hostname = new URL(candidate).hostname.toLowerCase();
    return hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

function ipv4Octets(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) {
    return null;
  }
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function isLocalIpv4(octets: number[]): boolean {
  const [first, second] = octets;
  return (
    first === 127 ||
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

export function isLocalModelEndpoint(
  baseUrl: string | null | undefined,
): boolean {
  const hostname = endpointHostname(baseUrl ?? "");
  if (!hostname) {
    return false;
  }
  if (
    LOCAL_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    return true;
  }
  const octets = ipv4Octets(hostname);
  return octets !== null && isLocalIpv4(octets);
}

const CONTEXT_OVERFLOW_PATTERN =
  /exceeds the available context size|maximum context length|context length of only|longer than the model'?s context length|context window exceeded|context_length_exceeded|n_ctx/i;

export function withLocalContextGuidance(message: string, providerId: string | null | undefined): string {
  if (!(providerId ?? "").trim().toLowerCase().startsWith("local_") || !CONTEXT_OVERFLOW_PATTERN.test(message)) {
    return message;
  }
  return (
    `${message}\n\nThe local model's context window is too small for this conversation. ` +
    "Restart the model server with 32768 tokens of context or more: llama.cpp `-c 32768`, " +
    "Ollama `OLLAMA_CONTEXT_LENGTH=32768`, LM Studio: reload the model with a larger Context Length, " +
    "vLLM `--max-model-len 32768`."
  );
}
