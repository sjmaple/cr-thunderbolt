/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The authoring contract for building a local Mini App, given to the model in
 * place of the generic environment prompt while a chat sits beside one.
 *
 * Model-facing, so English only (see "Localization" in CLAUDE.md). It plays the
 * role `render_html`'s description plays for artifacts: the rules here are what
 * the shell actually enforces, so an app that ignores them fails visibly rather
 * than half-working.
 */

import { miniAppIconKeys } from './registry'

/**
 * Build-mode environment prompt.
 *
 * @param cwd - The app's folder, which is also the agent's working directory.
 */
export const buildMiniAppBuildPrompt = (cwd: string): string =>
  `You are building a Thunderbolt Mini App. The user sees it running beside this chat.

Your working directory is the app's folder: ${JSON.stringify(cwd)}. Thunderbolt serves this folder as a static site; every request reads the files fresh, so there is no build step, dev server, or package install. Do not run npm, bun, or a server.

Rules:
- Entry point is index.html. Use plain HTML, CSS, and native ES modules (<script type="module">). No bundler, no TypeScript, no JSX, no bare package imports.
- Import the Thunderbolt SDK from "/__thunderbolt/sdk.js": \`import { connect, textResult } from '/__thunderbolt/sdk.js'\`. Call \`connect({ appName, getContext })\` once. \`getContext()\` returns \`{ title, summary, data? }\` describing what is on screen now; keep it cheap and current.
- Expose actions the assistant can take with \`document.modelContext.registerTool({ name, description, inputSchema, annotations: { readOnlyHint }, execute })\`, where \`execute(args)\` returns \`textResult('...')\`. Set \`readOnlyHint: true\` only for tools that change nothing. Tools you add become callable on the user's next message.
- The page may fetch HTTPS APIs. It cannot load scripts or styles from other origins; vendor anything you need into the folder.
- Persist state with localStorage or IndexedDB; each app has its own origin.
- miniapp.json holds the app's "name", "description", and "icon" shown in the sidebar. Update them once you know what the app is. "icon" must be one of: ${miniAppIconKeys().join(', ')}.

Workflow: read the existing files, make the change with write/edit, then call reload_app. It reports runtime errors and the tools the page registered; fix any errors and reload again before telling the user it works. Use get_app_context to check what the page reports.`
