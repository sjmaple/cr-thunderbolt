/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { isPrivateOrInternalAddress, parseIpAddress } from '@shared/ip-classification'

/** Upgrade public HTTP targets while allowing device-local HTTP servers. */
const upgradeNativeTarget = (input: RequestInfo | URL): RequestInfo | URL => {
  const url = new URL(input instanceof Request ? input.url : input.toString())
  if (url.protocol !== 'http:') {
    return input
  }
  const host = url.hostname.replace(/\.$/, '')
  const ip = parseIpAddress(host)
  if (
    (ip && isPrivateOrInternalAddress(ip)) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'host.docker.internal' ||
    host.endsWith('.local')
  ) {
    return input
  }
  // Arbitrary split-DNS private FQDNs are upgraded too; the hosted proxy also upgraded and SSRF-blocked them.
  url.protocol = 'https:'
  return input instanceof Request ? new Request(url, input) : url
}

/** Native HTTP with Fetch-compatible failures, cancellation and no credential-bearing redirects. */
export const nativeFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
  fetchImpl: typeof tauriFetch = tauriFetch,
): Promise<Response> => {
  const signal = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined
  signal?.throwIfAborted()
  const target = upgradeNativeTarget(input)
  // The plugin retains anonymous listeners; isolate them from shared MCP session signals.
  const child = new AbortController()
  const abort = () => child.abort(signal?.reason)
  const detach = () => signal?.removeEventListener('abort', abort)
  const failure = (cause: unknown) => (signal?.aborted ? signal.reason : new TypeError('Failed to fetch', { cause }))
  signal?.addEventListener('abort', abort, { once: true })

  const send = async () => {
    try {
      const response = await fetchImpl(target, { ...init, signal: child.signal, maxRedirections: 0 })
      if (signal?.aborted) {
        await response.body?.cancel(signal.reason)
        throw signal.reason
      }
      return response
    } catch (error) {
      detach()
      throw failure(error)
    }
  }
  const response = await send()
  if (!response.body) {
    detach()
    return response
  }

  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        signal?.throwIfAborted()
        if (done) {
          detach()
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch (error) {
        detach()
        controller.error(failure(error))
      }
    },
    async cancel(reason) {
      detach()
      try {
        await reader.cancel(reason)
      } catch (error) {
        throw failure(error)
      }
    },
  })
  const result = new Response(body, response)
  Object.defineProperty(result, 'url', { value: response.url })
  return result
}
