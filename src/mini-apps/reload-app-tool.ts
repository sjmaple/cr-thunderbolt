/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `reload_app` — the build loop's feedback for a local Mini App.
 *
 * The agent edits files on disk; the shell serves them fresh on every request,
 * so a reload is all it takes to run the new code. What the model cannot see is
 * whether that code works, so the tool waits for the reloaded document to
 * handshake and reports what the page said about itself: the bridge status, the
 * errors it raised, and the tools it registered.
 */

import { tool, type Tool } from 'ai'
import { z } from 'zod'
import { useMiniAppStore } from './mini-app-store'

/** Longer than the bridge's own handshake deadline, so its verdict lands first. */
const settleTimeoutMs = 10_000
/** Errors thrown during startup often arrive just after the handshake. */
const errorGraceMs = 750

export type ReloadAppResult = {
  status: 'ready' | 'unreachable' | 'timeout'
  errors: string[]
  tools: string[]
}

/** Resolve once the reload has been seen to start and then finish. */
const waitForSettle = (): Promise<'ready' | 'unreachable' | 'timeout'> =>
  new Promise((resolve) => {
    let sawConnecting = useMiniAppStore.getState().bridgeStatus === 'connecting'
    const finish = (result: 'ready' | 'unreachable' | 'timeout') => {
      clearTimeout(timer)
      unsubscribe()
      resolve(result)
    }
    const timer = setTimeout(() => finish('timeout'), settleTimeoutMs)
    const unsubscribe = useMiniAppStore.subscribe(({ bridgeStatus }) => {
      if (bridgeStatus === 'connecting') {
        sawConnecting = true
        return
      }
      if (sawConnecting) {
        finish(bridgeStatus)
      }
    })
  })

/**
 * Reload the open app and report how the new document started.
 *
 * Exported apart from the tool so it can be tested without the AI SDK wrapper.
 */
export const reloadOpenApp = async (): Promise<ReloadAppResult> => {
  const { reloadFrame } = useMiniAppStore.getState()
  if (!reloadFrame) {
    return { status: 'unreachable', errors: ['The app is not open.'], tools: [] }
  }
  const settled = waitForSettle()
  reloadFrame()
  const status = await settled
  await new Promise((resolve) => setTimeout(resolve, errorGraceMs))
  const { runtimeErrors, tools } = useMiniAppStore.getState()
  return { status, errors: runtimeErrors, tools: tools.map((t) => t.name) }
}

/** The tool, registered only while a local app is open. */
export const createReloadAppTool = (): Tool =>
  tool({
    description:
      'Reload the Mini App you are building and report whether it started: bridge status, runtime errors it raised, and the tools it registered. Call after changing its files.',
    inputSchema: z.object({}),
    execute: reloadOpenApp,
  })
