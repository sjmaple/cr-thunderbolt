/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { findLocalMiniApp } from '@/mini-apps/local-mini-apps'

export type ExecutionLocation = 'sandbox' | 'computer' | 'app' | 'cloud'
export type AgentExecution = { access: 'ask' | 'full' } & (
  | { location: 'computer'; cwd: string }
  /** Building a local Mini App: native tools rooted at the app's own folder. */
  | { location: 'app'; cwd: string; appId: string }
  | { location: 'sandbox' | 'cloud'; cwd?: string }
)
export const defaultAgentExecution: AgentExecution = { location: 'sandbox', access: 'ask' }

type ExecutionStore = {
  byThread: Record<string, AgentExecution>
  setExecution: (threadId: string, execution: AgentExecution) => void
}

/** Device-local choices: native paths and grants must never follow a chat through sync. */
export const useAgentExecutionStore = create<ExecutionStore>()(
  persist(
    (set) => ({
      byThread: {},
      setExecution: (threadId, execution) =>
        set((state) => ({ byThread: { ...state.byThread, [threadId]: execution } })),
    }),
    { name: 'thunderbolt-agent-execution-v1', partialize: (state) => ({ byThread: state.byThread }) },
  ),
)

/** Read the current thread's choice at send time, avoiding stale adapter closures. */
export const getAgentExecution = (threadId: string): AgentExecution =>
  useAgentExecutionStore.getState().byThread[threadId] ?? defaultAgentExecution

/**
 * The execution a send should use: a chat attached to a local Mini App builds
 * that app, keeping only the thread's access choice; anything else uses the
 * thread's stored choice.
 */
export const resolveAgentExecution = (threadId: string, miniAppId: string | null): AgentExecution => {
  const stored = getAgentExecution(threadId)
  const local = miniAppId ? findLocalMiniApp(miniAppId) : undefined
  if (!local) {
    return stored
  }
  return { location: 'app', appId: local.id, cwd: local.localPath, access: stored.access }
}
