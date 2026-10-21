/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Note: this test deliberately does NOT use `mock.module()`. Mocks of shared
// modules like `@/lib/platform` or `@tauri-apps/plugin-http` would leak across
// test files (see docs/internals/development/testing.md). Instead, both helpers accept
// `isStandalone` and a fetch override so tests can wire fakes via constructor
// arguments — pure dependency injection.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { encodeWsBearer } from '@shared/ws-bearer'
import { createProxyFetch, createProxyWebSocket } from './proxy-fetch'
import { appVersionUnsupported, isAppVersionBlocked, resetAppVersionBlockedForTesting } from './app-version-unsupported'
import { clearAuthToken, setAuthToken } from './auth-token'

describe('createProxyFetch — Hosted mode', () => {
  it('rewrites caller headers to X-Proxy-Passthrough-* and sets the target URL header', async () => {
    const calls: Array<{ url: string; method: string; headers: Headers }> = []
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString()
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
      calls.push({
        url,
        method: input instanceof Request ? input.method : (init?.method ?? 'GET'),
        headers,
      })
      return new Response('ok', {
        status: 200,
        headers: { 'X-Proxy-Passthrough-Content-Type': 'application/json', 'Content-Type': 'text/plain' },
      })
    }) as typeof fetch

    const proxyFetch = createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      fetchImpl: fakeFetch,
      isStandalone: () => false,
    })

    await proxyFetch('https://example.com/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-1' },
      body: JSON.stringify({ x: 1 }),
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://localhost:8000/v1/proxy')
    expect(calls[0].headers.get('x-proxy-target-url')).toBe('https://example.com/api')
    expect(calls[0].headers.get('x-proxy-passthrough-content-type')).toBe('application/json')
    expect(calls[0].headers.get('x-proxy-passthrough-mcp-session-id')).toBe('sess-1')
  })

  it('preserves a Request signal on the hosted hop unless explicitly overridden', async () => {
    for (const override of [false, true]) {
      const inherited = new AbortController()
      const explicit = new AbortController()
      const sent: Request[] = []
      const proxyFetch = createProxyFetch({
        cloudUrl: 'https://backend.example/v1',
        isStandalone: () => false,
        fetchImpl: Object.assign(
          async (input: RequestInfo | URL) => {
            sent.push(input as Request)
            return new Response('ok')
          },
          { preconnect: fetch.preconnect },
        ),
      })

      await proxyFetch(
        new Request('https://provider.example', { signal: inherited.signal }),
        override ? { signal: explicit.signal } : undefined,
      )
      inherited.abort()
      expect(sent[0].signal.aborted).toBe(!override)
      explicit.abort()
      expect(sent[0].signal.aborted).toBe(true)
    }
  })

  it('unwraps X-Proxy-Passthrough-* response headers into normal-looking headers', async () => {
    const fakeFetch = (async () =>
      new Response('ok', {
        status: 200,
        headers: { 'X-Proxy-Passthrough-Content-Type': 'application/json', 'Content-Type': 'text/plain' },
      })) as unknown as typeof fetch

    const proxyFetch = createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      fetchImpl: fakeFetch,
      isStandalone: () => false,
    })

    const res = await proxyFetch('https://example.com/api', { method: 'GET' })
    expect(res.headers.get('content-type')).toBe('application/json')
  })

  it('sends backend credentials even when the caller passes a same-origin Request', async () => {
    const outer: Request[] = []
    const fetchImpl: typeof fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        outer.push(new Request(input))
        return new Response('ok')
      },
      { preconnect: fetch.preconnect },
    )
    const proxyFetch = createProxyFetch({
      cloudUrl: 'https://api.thunderbolt.example/v1',
      fetchImpl,
      isStandalone: () => false,
    })

    // `same-origin` is the browser's default for `new Request(...)`, which is what `http` hands over.
    await proxyFetch(new Request('https://example.com/models', { credentials: 'same-origin' }))

    expect(outer[0].credentials).toBe('include')
  })
})

describe('createProxyFetch — app-version gate', () => {
  const upgradeEnvelope = {
    success: false,
    data: null,
    error: 'Upgrade Required',
    code: 'APP_VERSION_UNSUPPORTED',
    minAppVersion: '99.0.0',
  }

  /** Collect `appVersionUnsupported` events for the duration of one test. */
  const captureBlockEvents = (): { events: CustomEvent[]; dispose: () => void } => {
    const events: CustomEvent[] = []
    const listener = (event: Event) => events.push(event as CustomEvent)
    window.addEventListener(appVersionUnsupported, listener)
    return { events, dispose: () => window.removeEventListener(appVersionUnsupported, listener) }
  }

  const proxyFetchReturning = (response: () => Response) =>
    createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      fetchImpl: (async () => response()) as unknown as typeof fetch,
      isStandalone: () => false,
    })

  // Both ends: start clean regardless of what ran before, and leave clean.
  beforeEach(() => {
    resetAppVersionBlockedForTesting()
  })

  afterEach(() => {
    resetAppVersionBlockedForTesting()
  })

  it('raises the upgrade blocker when our gate rejects the outer hop', async () => {
    const { events, dispose } = captureBlockEvents()
    const proxyFetch = proxyFetchReturning(
      () => new Response(JSON.stringify(upgradeEnvelope), { status: 426, headers: { 'Content-Type': 'text/plain' } }),
    )

    await proxyFetch('https://api.openai.com/v1/chat/completions', { method: 'POST' })

    expect(events).toHaveLength(1)
    expect(events[0].detail).toEqual({ minAppVersion: '99.0.0' })
    expect(isAppVersionBlocked()).toBe(true)
    dispose()
  })

  it('ignores a 426 relayed from the external upstream', async () => {
    // The proxy copies upstream status codes verbatim, so a provider answering
    // 426 must never blank the app — only our `APP_VERSION_UNSUPPORTED` envelope
    // means "this build is too old".
    const { events, dispose } = captureBlockEvents()
    const proxyFetch = proxyFetchReturning(
      () =>
        new Response(JSON.stringify({ error: 'upstream wants a protocol upgrade' }), {
          status: 426,
          headers: { 'X-Proxy-Passthrough-Content-Type': 'application/json' },
        }),
    )

    await proxyFetch('https://api.openai.com/v1/chat/completions', { method: 'POST' })

    expect(events).toHaveLength(0)
    expect(isAppVersionBlocked()).toBe(false)
    dispose()
  })

  it('leaves the response body readable by the caller', async () => {
    const proxyFetch = proxyFetchReturning(() => new Response(JSON.stringify(upgradeEnvelope), { status: 426 }))

    const res = await proxyFetch('https://api.openai.com/v1/chat/completions', { method: 'POST' })

    expect(res.status).toBe(426)
    expect(await res.json()).toEqual(upgradeEnvelope)
  })

  it('does not raise the blocker on a successful proxy response', async () => {
    const { events, dispose } = captureBlockEvents()
    const proxyFetch = proxyFetchReturning(() => new Response('ok', { status: 200 }))

    await proxyFetch('https://api.openai.com/v1/chat/completions', { method: 'POST' })

    expect(events).toHaveLength(0)
    dispose()
  })
})

describe('createProxyFetch — Standalone (Tauri) mode', () => {
  it('calls Tauri fetch directly without rewriting headers when toggle is off and native_fetch is available', async () => {
    const tauriFetchMock = mock(async () => new Response('tauri-direct', { status: 200 }))

    const proxyFetch = createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      isStandalone: () => true,
      tauriFetch: tauriFetchMock as unknown as typeof fetch,
      getProxyEnabled: () => false,
      getNativeFetchCapability: () => Promise.resolve(true),
    })

    await proxyFetch('https://example.com/api', {
      method: 'GET',
      headers: { Authorization: 'Bearer abc' },
    })

    expect(tauriFetchMock).toHaveBeenCalledTimes(1)
    const [calledUrl, calledInit] = tauriFetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(calledUrl).toBe('https://example.com/api')
    const h = new Headers(calledInit.headers)
    expect(h.get('authorization')).toBe('Bearer abc')
  })

  it('throws an actionable named error without sending anything when native HTTP is missing', async () => {
    const tauriFetchMock = mock(async () => new Response('should-not-be-called', { status: 500 }))
    const hostedFetchMock = mock(async () => new Response('hosted', { status: 200 }))

    const proxyFetch = createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      isStandalone: () => true,
      tauriFetch: tauriFetchMock as unknown as typeof fetch,
      fetchImpl: hostedFetchMock as unknown as typeof fetch,
      getProxyEnabled: () => false,
      getNativeFetchCapability: () => Promise.resolve(false),
    })

    await expect(proxyFetch('https://example.com/api')).rejects.toMatchObject({
      name: 'NativeHttpUnavailableError',
      message: expect.stringMatching(/update.*enable Cloud Proxy/i),
    })
    expect(tauriFetchMock).not.toHaveBeenCalled()
    expect(hostedFetchMock).not.toHaveBeenCalled()
  })
})

describe('createProxyFetch — native request boundaries', () => {
  beforeEach(() => {
    localStorage.removeItem('proxy_enabled')
  })

  afterEach(() => {
    localStorage.removeItem('proxy_enabled')
    clearAuthToken()
    resetAppVersionBlockedForTesting()
  })

  it.each(['inherited', 'explicit', 'null'] as const)(
    'disables native redirects and forwards the Request signal (signal: %s)',
    async (override) => {
      const native = mock(
        async (_input: RequestInfo | URL, _init?: RequestInit & { maxRedirections?: number }) => new Response('ok'),
      )
      const request = new Request('https://provider.example/v1/messages', { signal: new AbortController().signal })
      const explicitSignal = new AbortController().signal
      const proxyFetch = createProxyFetch({
        cloudUrl: 'https://backend.example/v1',
        isStandalone: () => true,
        getNativeFetchCapability: async () => true,
        tauriFetch: native,
        fetchImpl: Object.assign(async () => new Response('unexpected backend'), { preconnect: fetch.preconnect }),
      })

      await proxyFetch(
        request,
        override === 'inherited' ? undefined : { signal: override === 'null' ? null : explicitSignal },
      )

      expect(native.mock.calls[0][0]).toBe(request)
      expect(native.mock.calls[0][1]?.signal).toBe(
        override === 'inherited' ? request.signal : override === 'null' ? null : explicitSignal,
      )
      expect(native.mock.calls[0][1]?.maxRedirections).toBe(0)
    },
  )

  it.each(['before', 'during'] as const)('reports AbortError when cancelled %s the native request', async (when) => {
    const controller = new AbortController()
    const proxyFetch = createProxyFetch({
      cloudUrl: 'https://backend.example/v1',
      isStandalone: () => true,
      getNativeFetchCapability: async () => true,
      tauriFetch: async () => {
        controller.abort()
        throw new Error('Request cancelled')
      },
    })
    if (when === 'before') {
      controller.abort()
    }

    const pending = proxyFetch('https://provider.example', { signal: controller.signal })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(pending).rejects.toBe(controller.signal.reason)
  })

  it('normalizes cancelled native bodies to AbortError and preserves other stream errors', async () => {
    for (const aborted of [false, true]) {
      const controller = new AbortController()
      let bodyController!: ReadableStreamDefaultController<Uint8Array>
      const upstream = new ReadableStream<Uint8Array>({
        start(stream) {
          bodyController = stream
          stream.enqueue(new TextEncoder().encode('chunk'))
        },
      })
      const proxyFetch = createProxyFetch({
        cloudUrl: 'https://backend.example/v1',
        isStandalone: () => true,
        getNativeFetchCapability: async () => true,
        tauriFetch: async () => new Response(upstream, { status: 201, headers: { 'x-provider': 'value' } }),
      })
      const response = await proxyFetch('https://provider.example', { signal: controller.signal })

      expect(response.status).toBe(201)
      expect(response.headers.get('x-provider')).toBe('value')
      const reader = response.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('chunk')
      if (aborted) {
        controller.abort()
      }
      bodyController.error('Request cancelled')
      await expect(reader.read()).rejects.toBe(aborted ? controller.signal.reason : 'Request cancelled')
    }
  })

  it('propagates native failures without retrying through the backend', async () => {
    const failure = new TypeError('native connection failed')
    const hosted = mock(async () => new Response('hosted'))
    const proxyFetch = createProxyFetch({
      cloudUrl: 'https://backend.example/v1',
      isStandalone: () => true,
      getNativeFetchCapability: async () => true,
      tauriFetch: async () => {
        throw failure
      },
      fetchImpl: Object.assign(hosted, { preconnect: fetch.preconnect }),
    })

    await expect(proxyFetch('https://provider.example')).rejects.toBe(failure)
    expect(hosted).not.toHaveBeenCalled()
  })

  it.each([
    [401, { code: 'UNAUTHENTICATED' }],
    [426, { code: 'APP_VERSION_UNSUPPORTED', minAppVersion: '99.0.0' }],
  ] as const)('does not treat a native provider %s as a backend rejection', async (status, body) => {
    setAuthToken('backend-token')
    const events: Event[] = []
    const listener = (event: Event) => events.push(event)
    window.addEventListener('powersync_credentials_invalid', listener)
    window.addEventListener(appVersionUnsupported, listener)
    const response = new Response(JSON.stringify(body), { status })
    const proxyFetch = createProxyFetch({
      cloudUrl: 'https://backend.example/v1',
      isStandalone: () => true,
      getNativeFetchCapability: async () => true,
      tauriFetch: async () => response,
      fetchImpl: Object.assign(async () => new Response('unexpected backend'), { preconnect: fetch.preconnect }),
    })
    try {
      const result = await proxyFetch('https://provider.example')
      expect(result).toBe(response)
      expect(await result.json()).toEqual(body)
      expect(events).toHaveLength(0)
      expect(isAppVersionBlocked()).toBe(false)
    } finally {
      window.removeEventListener('powersync_credentials_invalid', listener)
      window.removeEventListener(appVersionUnsupported, listener)
    }
  })
})

describe('createProxyFetch — proxy_enabled toggle', () => {
  afterEach(() => localStorage.removeItem('proxy_enabled'))

  it.each([null, 'false'])(
    'Tauri with stored %s defaults to native HTTP and never calls the backend',
    async (stored) => {
      localStorage.removeItem('proxy_enabled')
      if (stored !== null) {
        localStorage.setItem('proxy_enabled', stored)
      }
      const native = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('direct'))
      const hosted = mock(async (_input: RequestInfo | URL) => new Response('hosted'))
      const auth = mock(() => 'backend-token')
      const proxyFetch = createProxyFetch({
        cloudUrl: 'https://backend.example/v1',
        isStandalone: () => true,
        getNativeFetchCapability: async () => true,
        tauriFetch: native,
        fetchImpl: Object.assign(hosted, { preconnect: fetch.preconnect }),
        getProxyAuthToken: auth,
      })

      await proxyFetch('https://provider.example/v1/messages', { headers: { 'x-api-key': 'provider-key' } })

      expect(native).toHaveBeenCalledTimes(1)
      expect(hosted).not.toHaveBeenCalled()
      expect(auth).not.toHaveBeenCalled()
      const [, init] = native.mock.calls[0]
      expect(new Headers(init?.headers).get('x-api-key')).toBe('provider-key')
      expect(new Headers(init?.headers).has('x-app-version')).toBe(false)
      expect(new Headers(init?.headers).has('authorization')).toBe(false)

      localStorage.setItem('proxy_enabled', 'true')
      await proxyFetch('https://provider.example/v1/messages')
      expect(hosted).toHaveBeenCalledTimes(1)
      expect(native).toHaveBeenCalledTimes(1)
      const hostedRequest = new Request(hosted.mock.calls[0][0])
      expect(hostedRequest.url).toBe('https://backend.example/v1/proxy')

      localStorage.setItem('proxy_enabled', 'false')
      const webFetch = createProxyFetch({
        cloudUrl: 'https://backend.example/v1',
        isStandalone: () => false,
        fetchImpl: Object.assign(hosted, { preconnect: fetch.preconnect }),
      })
      await webFetch('https://provider.example/v1/messages')
      expect(hosted).toHaveBeenCalledTimes(2)
    },
  )

  it('Tauri + toggle on: routes through the hosted proxy (privacy mode)', async () => {
    const tauriFetchMock = mock(async () => new Response('should-not-be-called', { status: 500 }))
    const hostedFetchMock = mock(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString()
      return new Response(`hosted:${url}`, { status: 200 })
    })

    const proxyFetch = createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      isStandalone: () => true,
      tauriFetch: tauriFetchMock as unknown as typeof fetch,
      fetchImpl: hostedFetchMock as unknown as typeof fetch,
      getProxyEnabled: () => true,
    })

    await proxyFetch('https://example.com/api', { method: 'GET' })

    expect(tauriFetchMock).toHaveBeenCalledTimes(0)
    expect(hostedFetchMock).toHaveBeenCalledTimes(1)
    const [hostedReq] = hostedFetchMock.mock.calls[0] as unknown as [Request]
    expect(hostedReq.url).toBe('http://localhost:8000/v1/proxy')
    expect(hostedReq.headers.get('x-proxy-target-url')).toBe('https://example.com/api')
  })

  it('Web (not standalone): always proxies, ignoring the toggle value', async () => {
    const hostedFetchMock = mock(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString()
      return new Response(`hosted:${url}`, { status: 200 })
    })

    const proxyFetch = createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      isStandalone: () => false,
      fetchImpl: hostedFetchMock as unknown as typeof fetch,
      // Even with the toggle "off", Web must still proxy — CORS forces it.
      getProxyEnabled: () => false,
    })

    await proxyFetch('https://example.com/api', { method: 'GET' })

    expect(hostedFetchMock).toHaveBeenCalledTimes(1)
    const [hostedReq] = hostedFetchMock.mock.calls[0] as unknown as [Request]
    expect(hostedReq.url).toBe('http://localhost:8000/v1/proxy')
  })

  it('defaults to hosted routing on web when getProxyEnabled is omitted', async () => {
    const hostedFetchMock = mock(async () => new Response('ok', { status: 200 }))

    const proxyFetch = createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      isStandalone: () => false,
      fetchImpl: hostedFetchMock as unknown as typeof fetch,
      // getProxyEnabled omitted on purpose.
    })

    await proxyFetch('https://example.com/api', { method: 'GET' })

    expect(hostedFetchMock).toHaveBeenCalledTimes(1)
    const [hostedReq] = hostedFetchMock.mock.calls[0] as unknown as [Request]
    expect(hostedReq.url).toBe('http://localhost:8000/v1/proxy')
  })
})

describe('createProxyFetch — getProxyAuthToken wiring', () => {
  it('attaches `Authorization: Bearer <token>` on the proxy Request when the getter returns a token', async () => {
    const calls: Array<{ url: string; headers: Headers }> = []
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const req = input as Request
      calls.push({ url: req.url, headers: new Headers(req.headers) })
      return new Response('ok', { status: 200 })
    }) as typeof fetch

    const proxyFetch = createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      fetchImpl: fakeFetch,
      isStandalone: () => false,
      getProxyAuthToken: () => 'session-token-abc',
    })

    await proxyFetch('https://example.com/api', { method: 'GET' })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://localhost:8000/v1/proxy')
    expect(calls[0].headers.get('authorization')).toBe('Bearer session-token-abc')
  })

  it('omits the Authorization header when the getter is absent or returns null', async () => {
    const captureAuth = (input: RequestInfo | URL): string | null =>
      new Headers((input as Request).headers).get('authorization')

    const withoutGetterCalls: Array<string | null> = []
    const proxyFetchNoGetter = createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      fetchImpl: (async (input) => {
        withoutGetterCalls.push(captureAuth(input))
        return new Response('ok', { status: 200 })
      }) as typeof fetch,
      isStandalone: () => false,
    })
    await proxyFetchNoGetter('https://example.com/api', { method: 'GET' })
    expect(withoutGetterCalls).toEqual([null])

    const withNullGetterCalls: Array<string | null> = []
    const proxyFetchNullGetter = createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      fetchImpl: (async (input) => {
        withNullGetterCalls.push(captureAuth(input))
        return new Response('ok', { status: 200 })
      }) as typeof fetch,
      isStandalone: () => false,
      getProxyAuthToken: () => null,
    })
    await proxyFetchNullGetter('https://example.com/api', { method: 'GET' })
    expect(withNullGetterCalls).toEqual([null])
  })
})

describe('createProxyWebSocket', () => {
  /** Minimal FakeWebSocket capturing the url + offered subprotocols. */
  class FakeWS {
    static instances: Array<FakeWS> = []
    readyState = 0
    url: string
    protocols: string[]
    constructor(u: string, p?: string[]) {
      this.url = u
      this.protocols = p ?? []
      FakeWS.instances.push(this)
    }
    addEventListener() {}
    removeEventListener() {}
    send() {}
    close() {}
  }

  it('Hosted: includes carrier + bearer + target subprotocols on /proxy/ws', () => {
    FakeWS.instances = []
    const originalWS = globalThis.WebSocket
    globalThis.WebSocket = FakeWS as unknown as typeof WebSocket
    try {
      const factory = createProxyWebSocket({
        cloudUrl: 'http://localhost:8000/v1',
        isStandalone: () => false,
        getAuthToken: () => 'bearer-abc',
      })
      factory('wss://upstream.test/path', ['acp.v1'])
      expect(FakeWS.instances).toHaveLength(1)
      const real = FakeWS.instances[0]
      expect(real.url).toBe('ws://localhost:8000/v1/proxy/ws')
      expect(real.protocols[0]).toBe('thunderbolt.v1')
      expect(real.protocols[1]).toBe(`thunderbolt.bearer.${encodeWsBearer('bearer-abc')}`)
      expect(real.protocols[2]?.startsWith('tbproxy.target.')).toBe(true)
      expect(real.protocols[3]).toBe('acp.v1')
    } finally {
      globalThis.WebSocket = originalWS
    }
  })

  it('Hosted: omits the bearer entry when no token is available (still offers carrier + target)', () => {
    FakeWS.instances = []
    const originalWS = globalThis.WebSocket
    globalThis.WebSocket = FakeWS as unknown as typeof WebSocket
    try {
      const factory = createProxyWebSocket({
        cloudUrl: 'http://localhost:8000/v1',
        isStandalone: () => false,
        getAuthToken: () => null,
      })
      factory('wss://upstream.test/path')
      expect(FakeWS.instances).toHaveLength(1)
      const real = FakeWS.instances[0]
      expect(real.protocols[0]).toBe('thunderbolt.v1')
      expect(real.protocols.some((p) => p.startsWith('thunderbolt.bearer.'))).toBe(false)
      expect(real.protocols.some((p) => p.startsWith('tbproxy.target.'))).toBe(true)
    } finally {
      globalThis.WebSocket = originalWS
    }
  })

  it('Standalone: connects directly to the target URL with no bearer attached', () => {
    FakeWS.instances = []
    const originalWS = globalThis.WebSocket
    globalThis.WebSocket = FakeWS as unknown as typeof WebSocket
    try {
      let tokenReads = 0
      const factory = createProxyWebSocket({
        cloudUrl: 'http://localhost:8000/v1',
        isStandalone: () => true,
        getAuthToken: () => {
          tokenReads += 1
          return 'never-read'
        },
      })
      factory('wss://upstream.test/path')
      expect(FakeWS.instances).toHaveLength(1)
      expect(FakeWS.instances[0].url).toBe('wss://upstream.test/path')
      expect(tokenReads).toBe(0)
    } finally {
      globalThis.WebSocket = originalWS
    }
  })
})

describe('createProxyFetch — session rejected', () => {
  const unauthenticated = JSON.stringify({ code: 'UNAUTHENTICATED' })
  const originalDispatch = window.dispatchEvent
  let dispatchSpy: ReturnType<typeof mock>

  const proxyFetchReturning = (response: () => Response) =>
    createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      fetchImpl: (async () => response()) as unknown as typeof fetch,
      isStandalone: () => false,
    })

  beforeEach(() => {
    setAuthToken('app-token')
    dispatchSpy = mock(() => true)
    window.dispatchEvent = dispatchSpy as unknown as typeof window.dispatchEvent
  })

  afterEach(() => {
    window.dispatchEvent = originalDispatch
    clearAuthToken()
  })

  it('treats our own auth gate rejecting the outer hop as a lost session', async () => {
    const proxyFetch = proxyFetchReturning(() => new Response(unauthenticated, { status: 401 }))

    await proxyFetch('https://api.openai.com/v1/chat/completions', { method: 'POST' })

    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    expect((dispatchSpy.mock.calls[0][0] as CustomEvent).detail).toEqual({ reason: 'session_expired' })
  })

  it('ignores the same body when an upstream relays it, so a hostile server cannot sign the user out', async () => {
    const proxyFetch = proxyFetchReturning(
      () =>
        new Response(unauthenticated, { status: 401, headers: { 'X-Proxy-Final-Url': 'https://mcp.example.com/' } }),
    )

    await proxyFetch('https://mcp.example.com/', { method: 'POST' })

    expect(dispatchSpy).not.toHaveBeenCalled()
  })
})
