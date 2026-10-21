/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { nativeFetch } from './native-fetch'

it.each(
  [
    'http://api.example.com:8080/v1/messages?q=one',
    'http://[2002:c000:0204::1]/',
    'http://[2001:0::1]/',
    'http://192.88.99.1/',
  ].flatMap((url) => (['string', 'URL', 'Request'] as const).map((kind) => [kind, url] as const)),
)('upgrades public HTTP %s input %s with method, headers and body intact', async (kind, url) => {
  const init = { method: 'POST', headers: { 'x-api-key': 'provider-key' }, body: 'payload' }
  const input = kind === 'string' ? url : kind === 'URL' ? new URL(url) : new Request(url, init)
  const sent: Request[] = []
  await nativeFetch(input, kind === 'Request' ? undefined : init, async (input, options) => {
    sent.push(new Request(input, options))
    return new Response(null, { status: 204 })
  })
  expect(sent[0].url).toBe(new URL(url.replace('http:', 'https:')).href)
  expect(sent[0].method).toBe('POST')
  expect(sent[0].headers.get('x-api-key')).toBe('provider-key')
  expect(await sent[0].text()).toBe('payload')
})

it.each([
  'localhost',
  'api.localhost',
  '127.0.0.2',
  '[::1]',
  '10.1.2.3',
  '172.16.0.2',
  '192.168.1.2',
  '[fd00::1]',
  '[::ffff:192.168.1.2]',
  '[::192.168.1.10]',
  '[fe80::1]',
  '169.254.1.2',
  '100.64.0.1',
  '0.0.0.0',
  '[::]',
  'host.docker.internal',
  'server.local',
  'SERVER.LOCAL.',
  'api.localhost.',
])('keeps local/private HTTP target %s on plain HTTP', async (host) => {
  const url = new URL(`http://${host}:8080/v1`).href
  const sent: Request[] = []
  await nativeFetch(url, undefined, async (input, options) => {
    sent.push(new Request(input, options))
    return new Response(null, { status: 204 })
  })
  expect(sent[0].url).toBe(url)
})

it('keeps Request overrides when upgrading public HTTP', async () => {
  const request = new Request('http://api.example.com/v1', { method: 'POST', body: 'original' })
  const sent: Request[] = []
  await nativeFetch(
    request,
    { method: 'PUT', body: 'override', headers: { 'x-api-key': 'override-key' } },
    async (input, init) => {
      // Happy DOM ignores body overrides on Request inputs; read the supplied override against its URL.
      sent.push(new Request(input instanceof Request ? input.url : input, init))
      return new Response(null, { status: 204 })
    },
  )
  expect(sent[0].url).toBe('https://api.example.com/v1')
  expect(sent[0].method).toBe('PUT')
  expect(sent[0].headers.get('x-api-key')).toBe('override-key')
  expect(await sent[0].text()).toBe('override')
})
