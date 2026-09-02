import {
  inspectHomeserverLogin,
  normalizeHomeserverUrl,
  type ClientBuilderLike,
} from './homeserver-login';

function createBuilder() {
  const loginDetails = {
    url: jest.fn(() => 'https://login.example.test'),
    supportsOauthLogin: jest.fn(() => true),
    supportsPasswordLogin: jest.fn(() => false),
  };
  const client = {
    homeserverLoginDetails: jest.fn(async () => loginDetails),
  };
  const builder: ClientBuilderLike = {
    homeserverUrl: jest.fn(() => builder),
    build: jest.fn(async () => client),
  };
  return { builder, client };
}

describe('homeserver login smoke test', () => {
  it('normalizes an HTTPS URL and reports SDK login capabilities', async () => {
    const { builder, client } = createBuilder();

    await expect(
      inspectHomeserverLogin(' https://matrix.example.test/ ', builder)
    ).resolves.toBe(
      [
        'url: https://login.example.test',
        'supportsOauthLogin: true',
        'supportsPasswordLogin: false',
      ].join('\n')
    );
    expect(builder.homeserverUrl).toHaveBeenCalledWith(
      'https://matrix.example.test'
    );
    expect(builder.build).toHaveBeenCalledTimes(1);
    expect(client.homeserverLoginDetails).toHaveBeenCalledTimes(1);
  });

  it('allows HTTP only for loopback development', () => {
    expect(normalizeHomeserverUrl('http://127.0.0.1:8008/')).toBe(
      'http://127.0.0.1:8008'
    );
    expect(normalizeHomeserverUrl('http://[::1]:8008/')).toBe(
      'http://[::1]:8008'
    );
    expect(() => normalizeHomeserverUrl('http://matrix.example.test')).toThrow(
      /HTTPS/
    );
  });

  it('rejects invalid or credential-bearing homeserver URLs', () => {
    expect(() => normalizeHomeserverUrl('not-a-url')).toThrow(/valid/);
    expect(() =>
      normalizeHomeserverUrl('https://user:password@matrix.example.test')
    ).toThrow(/credentials/);
    expect(() =>
      normalizeHomeserverUrl('https://matrix.example.test?token=secret')
    ).toThrow(/query/);
  });
});
