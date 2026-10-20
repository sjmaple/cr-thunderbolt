/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as tauriCore from '@tauri-apps/api/core'
import * as platform from '@/lib/platform'
import { resolveAgentExecution, useAgentExecutionStore } from '@/agent-execution/store'
import {
  createLocalMiniApp,
  findLocalMiniApp,
  isManifestPath,
  refreshLocalMiniApps,
  useLocalMiniAppsStore,
} from './local-mini-apps'

const todo = { id: 'todo-18f', name: 'Todo', description: 'Tasks', icon: 'table', path: '/data/mini-apps/todo-18f' }

afterEach(() => {
  mock.restore()
  useLocalMiniAppsStore.setState({ apps: [], loaded: true })
  useAgentExecutionStore.setState({ byThread: {} })
})

describe('local Mini Apps', () => {
  it('serves each app from its own tbapp origin', async () => {
    spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
    spyOn(tauriCore, 'invoke').mockResolvedValue([todo])

    await refreshLocalMiniApps()

    expect(useLocalMiniAppsStore.getState().loaded).toBe(true)
    expect(findLocalMiniApp('todo-18f')).toMatchObject({
      url: 'tbapp://todo-18f/',
      origin: 'tbapp://todo-18f',
      localPath: '/data/mini-apps/todo-18f',
    })
  })

  it('does not ask the shell outside the desktop app', async () => {
    spyOn(platform, 'isTauriDesktop').mockReturnValue(false)
    const invoke = spyOn(tauriCore, 'invoke')

    await refreshLocalMiniApps()

    expect(invoke).not.toHaveBeenCalled()
  })

  it('a listing failure still ends loading, so routes stop waiting', async () => {
    spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
    spyOn(tauriCore, 'invoke').mockRejectedValue(new Error('disk'))
    spyOn(console, 'error').mockImplementation(() => {})

    await refreshLocalMiniApps()

    expect(useLocalMiniAppsStore.getState()).toEqual({ apps: [], loaded: true })
  })

  it('a created app is in the list before the caller navigates to it', async () => {
    spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
    // Create answers first, then the refresh that follows it lists the app.
    spyOn(tauriCore, 'invoke').mockResolvedValueOnce(todo).mockResolvedValueOnce([todo])

    const created = await createLocalMiniApp('Todo')

    expect(findLocalMiniApp(created.id)).toBeDefined()
  })

  it('recognizes the manifest by file name, relative or absolute', () => {
    expect(isManifestPath('miniapp.json')).toBe(true)
    expect(isManifestPath('/data/mini-apps/todo/miniapp.json')).toBe(true)
    expect(isManifestPath('notminiapp.json')).toBe(false)
  })
})

describe('resolveAgentExecution', () => {
  it('builds the local app a chat belongs to, keeping the chat access choice', async () => {
    spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
    spyOn(tauriCore, 'invoke').mockResolvedValue([todo])
    await refreshLocalMiniApps()
    useAgentExecutionStore.getState().setExecution('chat', { location: 'sandbox', access: 'full' })

    expect(resolveAgentExecution('chat', 'todo-18f')).toEqual({
      location: 'app',
      appId: 'todo-18f',
      cwd: '/data/mini-apps/todo-18f',
      access: 'full',
    })
  })

  it('leaves chats for deployment apps and loose chats on their stored choice', () => {
    useAgentExecutionStore.getState().setExecution('chat', { location: 'computer', access: 'ask', cwd: '/w' })

    expect(resolveAgentExecution('chat', 'finance-model')).toEqual({ location: 'computer', access: 'ask', cwd: '/w' })
    expect(resolveAgentExecution('chat', null)).toEqual({ location: 'computer', access: 'ask', cwd: '/w' })
  })
})
