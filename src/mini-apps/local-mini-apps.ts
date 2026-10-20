/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Mini Apps built on this computer.
 *
 * The deployment registry (`GET /mini-apps`) is operator config: it carries a
 * signing secret and needs a backend restart to change. A local app has neither
 * concern — it has no identity token, and the desktop shell serves its folder
 * straight off disk on `tbapp://<id>/` (`src-tauri/src/mini_app_host.rs`). So
 * the list comes from the shell instead, and refreshing it is all it takes for
 * a new app to appear.
 *
 * Device-local on purpose, for the reason `useAgentExecutionStore` gives: the
 * paths only mean something on this machine.
 */

import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import { isTauriDesktop } from '@/lib/platform'
import { resolveMiniAppIcon, type LocalMiniAppDefinition } from './registry'

/** One app as `mini_apps_list` reports it. */
type LocalMiniAppResponse = {
  id: string
  name: string
  description: string
  icon: string
  path: string
}

export const localMiniAppScheme = 'tbapp'

/** Origin the shell serves an app from; its id is the host, so each app gets its own. */
export const localMiniAppOrigin = (id: string): string => `${localMiniAppScheme}://${id}`

const toDefinition = (app: LocalMiniAppResponse): LocalMiniAppDefinition => ({
  id: app.id,
  name: app.name,
  description: app.description,
  icon: resolveMiniAppIcon(app.icon),
  url: `${localMiniAppOrigin(app.id)}/`,
  origin: localMiniAppOrigin(app.id),
  localPath: app.path,
})

type LocalMiniAppsState = {
  apps: LocalMiniAppDefinition[]
  /** False until the first read from disk lands, so a deep link waits instead of 404ing. */
  loaded: boolean
}

export const useLocalMiniAppsStore = create<LocalMiniAppsState>(() => ({ apps: [], loaded: !isTauriDesktop() }))

let initialLoad: Promise<void> | null = null

/**
 * Re-read the local apps from disk. A no-op outside the desktop app, where there
 * is no shell to serve them.
 */
export const refreshLocalMiniApps = async (): Promise<void> => {
  if (!isTauriDesktop()) {
    return
  }
  try {
    const apps = await invoke<LocalMiniAppResponse[]>('mini_apps_list')
    useLocalMiniAppsStore.setState({ apps: apps.map(toDefinition), loaded: true })
  } catch (error) {
    // Logged, and the list marked loaded: a broken app folder should cost the
    // local apps, not leave every Mini App route waiting forever.
    console.error('[mini-apps] Could not list local apps', error)
    useLocalMiniAppsStore.setState({ loaded: true })
  }
}

/** First read from disk, shared by every mount that asks. */
export const ensureLocalMiniAppsLoaded = (): Promise<void> => (initialLoad ??= refreshLocalMiniApps())

/** Create a starter app on disk and return it, already in the list. */
export const createLocalMiniApp = async (name: string, description = ''): Promise<LocalMiniAppDefinition> => {
  const created = toDefinition(await invoke<LocalMiniAppResponse>('mini_apps_create', { name, description }))
  await refreshLocalMiniApps()
  return created
}

/** Soft-delete: the shell tombstones the manifest and keeps the files. */
export const deleteLocalMiniApp = async (id: string): Promise<void> => {
  await invoke('mini_apps_delete', { id })
  await refreshLocalMiniApps()
}

/** Look up a local app by id outside React. */
export const findLocalMiniApp = (id: string): LocalMiniAppDefinition | undefined =>
  useLocalMiniAppsStore.getState().apps.find((app) => app.id === id)

/** Whether a path the agent wrote is an app's manifest, whose name the sidebar shows. */
export const isManifestPath = (path: string): boolean => /(^|[\\/])miniapp\.json$/.test(path)
