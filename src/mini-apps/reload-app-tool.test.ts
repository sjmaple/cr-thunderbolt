/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from 'bun:test'
import { getClock } from '@/testing-library'
import { useMiniAppStore } from './mini-app-store'
import { reloadOpenApp } from './reload-app-tool'

// Before, not after: other files leave a bridge installed in this shared store.
beforeEach(() => {
  useMiniAppStore.setState({ reloadFrame: null, bridgeStatus: 'connecting', runtimeErrors: [], tools: [] })
})

/** A frame whose reload runs `afterReload` once the bridge has started reconnecting. */
const installFrame = (afterReload: () => void) =>
  useMiniAppStore.setState({
    bridgeStatus: 'ready',
    reloadFrame: () => {
      useMiniAppStore.setState({ bridgeStatus: 'connecting', runtimeErrors: [], tools: [] })
      setTimeout(afterReload, 0)
    },
  })

describe('reload_app', () => {
  it('reports the errors and tools of the reloaded document', async () => {
    installFrame(() => {
      useMiniAppStore.setState({
        bridgeStatus: 'ready',
        tools: [{ name: 'add_task', description: 'Add', inputSchema: { type: 'object' } }],
      })
      useMiniAppStore.getState().reportRuntimeError('TypeError: x is undefined')
    })

    const result = reloadOpenApp()
    await getClock().runAllAsync()
    expect(await result).toEqual({
      status: 'ready',
      errors: ['TypeError: x is undefined'],
      tools: ['add_task'],
    })
  })

  it('does not mistake the previous document for the reloaded one', async () => {
    installFrame(() => useMiniAppStore.setState({ bridgeStatus: 'unreachable' }))

    const result = reloadOpenApp()
    await getClock().runAllAsync()
    expect((await result).status).toBe('unreachable')
  })

  it('says so when no app is open', async () => {
    expect(await reloadOpenApp()).toEqual({ status: 'unreachable', errors: ['The app is not open.'], tools: [] })
  })
})
