/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The SDK as served to local Mini Apps at `/__thunderbolt/sdk.js`.
 *
 * Local apps have no build step, so they import a prebuilt browser module rather
 * than the TypeScript package. React is left out (no bundler to resolve it), and
 * `connect` already knows its host: the desktop app swaps the placeholder below
 * for the main window's origin as it serves the file.
 */

import { connect as connectTo, type ConnectOptions, type Connection } from './bridge'

export { isEmbedded, type DownloadableFile, type HostContext, type MiniAppContext, type Theme } from './bridge'
export { textResult, type ModelContextTool, type ModelContextToolResult } from './model-context'

const hostOrigin = '__THUNDERBOLT_HOST_ORIGIN__'

/** Connect to the Thunderbolt window that is serving this app. */
export const connect = (options: Omit<ConnectOptions, 'hostOrigin'>, timeoutMs?: number): Promise<Connection> =>
  connectTo({ ...options, hostOrigin }, timeoutMs)
