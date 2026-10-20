/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState, useTransition } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useLingui } from '@lingui/react/macro'
import { defaultAgentExecution, useAgentExecutionStore } from '@/agent-execution/store'
import { isTauriDesktop } from '@/lib/platform'
import { useLocalMiniAppsStore } from '@/mini-apps/local-mini-apps'

/** Keeps workspace validation and local runtime settings outside the controls' markup. */
export const useAgentExecutionControlsState = (threadId: string, miniAppId: string | null = null) => {
  const { t } = useLingui()
  // A chat beside a local app builds that app; the location is not the user's to pick.
  const buildingApp = useLocalMiniAppsStore((state) =>
    miniAppId ? state.apps.find((app) => app.id === miniAppId) : undefined,
  )
  const execution = useAgentExecutionStore((state) => state.byThread[threadId] ?? defaultAgentExecution)
  const setExecution = useAgentExecutionStore((state) => state.setExecution)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const openFolder = () =>
    startTransition(async () => {
      setError(null)
      try {
        const cwd = await invoke<string | null>('agent_pick_workspace', {
          path: execution.cwd ?? null,
          title: t`Work on this computer`,
        })
        if (cwd !== null) {
          setExecution(threadId, { ...execution, location: 'computer', cwd })
        }
      } catch {
        setError(t`Could not select a working folder. Please try again.`)
      }
    })
  return {
    execution,
    setExecution: (next: typeof execution) => setExecution(threadId, next),
    desktop: isTauriDesktop(),
    buildingApp,
    error,
    pending,
    openFolder,
  }
}
