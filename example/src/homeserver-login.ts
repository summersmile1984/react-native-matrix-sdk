export interface HomeserverLoginDetailsLike {
  url(): string;
  supportsOauthLogin(): boolean;
  supportsPasswordLogin(): boolean;
}

export interface MatrixClientLike {
  homeserverLoginDetails(): Promise<HomeserverLoginDetailsLike>;
}

export interface ClientBuilderLike {
  homeserverUrl(url: string): ClientBuilderLike;
  build(): Promise<MatrixClientLike>;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

export function normalizeHomeserverUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Enter a valid homeserver URL');
  }

  const allowedProtocol =
    parsed.protocol === 'https:' ||
    (parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname));
  if (!allowedProtocol) {
    throw new Error('Homeserver must use HTTPS (HTTP is loopback-only)');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Homeserver URL must not contain credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Homeserver URL must not contain a query or fragment');
  }
  return parsed.toString().replace(/\/$/, '');
}

export async function inspectHomeserverLogin(
  rawUrl: string,
  builder: ClientBuilderLike
): Promise<string> {
  const homeserverUrl = normalizeHomeserverUrl(rawUrl);
  const client = await builder.homeserverUrl(homeserverUrl).build();
  const loginDetails = await client.homeserverLoginDetails();

  return [
    `url: ${loginDetails.url()}`,
    `supportsOauthLogin: ${loginDetails.supportsOauthLogin()}`,
    `supportsPasswordLogin: ${loginDetails.supportsPasswordLogin()}`,
  ].join('\n');
}
