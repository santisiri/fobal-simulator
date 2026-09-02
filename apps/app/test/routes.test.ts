// The unified app's route table — the pure layer under the router. What is
// locked down: the route shapes the docs committed to, the two URL modes
// (clean paths behind a rewrite, ?p= on any dumb static host), and the dev
// ?lobby= override surviving every href the app builds.
import { describe, expect, test } from 'vitest';
import { NOT_FOUND, ROUTES, currentPath, detectMode, hrefFor, legacyHref, matchPattern, matchRoute, normalizePath } from '../src/routes.js';

describe('normalizePath', () => {
  test('roots, trailing slashes and the document name all collapse', () => {
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('/app.html')).toBe('/');
    expect(normalizePath('/market/42/')).toBe('/market/42');
    expect(normalizePath('market')).toBe('/market');
    expect(normalizePath('/squad?lobby=x#y')).toBe('/squad');
  });
});

describe('matchRoute', () => {
  test('the committed route shapes all resolve', () => {
    expect(matchRoute('/').route.view).toBe('club');
    expect(matchRoute('/onboarding').route.view).toBe('onboarding');
    expect(matchRoute('/squad').route.view).toBe('squad');   // absorbed in J2
    expect(matchRoute('/market').route.view).toBe('market'); // absorbed in J3
    expect(matchRoute('/lobby').route.view).toBe('lobby');   // absorbed in J4
    expect(matchRoute('/play').route.legacy).toBe('play.html');
    expect(matchRoute('/invite').route.legacy).toBe('invite.html');
  });

  test('market deep links carry the token id out as a param, same view either way', () => {
    const m = matchRoute('/market/42');
    expect(m.route.view).toBe('market');
    expect(m.params).toEqual({ tokenId: '42' });
    expect(matchRoute('/market').route.view).toBe('market');
    expect(matchRoute('/market').params).toEqual({});
  });

  test('an unknown corridor is NOT_FOUND, never a throw', () => {
    expect(matchRoute('/treasury/vault/9').route).toBe(NOT_FOUND);
    expect(matchRoute('/../../etc').route).toBe(NOT_FOUND);
  });

  test('every route in the table matches its own path (no dead patterns)', () => {
    for (const r of ROUTES) {
      const probe = (r.path ?? '').replace(/:([a-zA-Z]+)/g, '7');
      expect(matchRoute(probe).route.path).toBe(r.path);
    }
  });
});

describe('matchPattern', () => {
  test('params decode; literal segments must agree', () => {
    expect(matchPattern('/market/:tokenId', '/market/a%20b')).toEqual({ tokenId: 'a b' });
    expect(matchPattern('/market/:tokenId', '/squad/7')).toBeNull();
    expect(matchPattern('/market', '/market/7')).toBeNull();
  });
});

describe('URL modes', () => {
  test('a document still named .html routes via the query string', () => {
    expect(detectMode('/app.html')).toBe('query');
    expect(detectMode('/apps/app/public/app.html')).toBe('query');
    expect(detectMode('/')).toBe('path');
    expect(detectMode('/squad')).toBe('path');
  });

  test('currentPath reads each mode', () => {
    expect(currentPath({ pathname: '/squad', search: '' })).toBe('/squad');
    expect(currentPath({ pathname: '/app.html', search: '?p=/market/7' })).toBe('/market/7');
    expect(currentPath({ pathname: '/app.html', search: '?lobby=http://x' })).toBe('/');
  });

  test('hrefFor builds mode-correct links that keep the dev override', () => {
    expect(hrefFor('/squad')).toBe('/squad');
    expect(hrefFor('/', { mode: 'path', keep: { lobby: 'http://localhost:8475' } }))
      .toBe('/?lobby=http%3A%2F%2Flocalhost%3A8475');
    expect(hrefFor('/', { mode: 'query' })).toBe('/app.html');
    expect(hrefFor('/onboarding', { mode: 'query' })).toBe('/app.html?p=%2Fonboarding');
    expect(hrefFor('/onboarding', { mode: 'query', docPath: 'app.html', keep: { lobby: 'http://x' } }))
      .toBe('app.html?p=%2Fonboarding&lobby=http%3A%2F%2Fx');
    // null/empty keeps are dropped, not serialized
    expect(hrefFor('/squad', { keep: { lobby: null } })).toBe('/squad');
  });

  test('legacy hand-offs are root-absolute (the app answers nested paths), override intact', () => {
    expect(legacyHref('play.html', {})).toBe('/play.html');
    expect(legacyHref('invite.html', { keep: { lobby: 'http://x' } }))
      .toBe('/invite.html?lobby=http%3A%2F%2Fx');
  });
});
